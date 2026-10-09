# Meltemi Mold Studio -> Autodesk Fusion (Fusion 360) importer script.
#
# Imports every STL of a Meltemi Mold Studio export folder (the CLI output folder or the unzipped
# "Export ZIP" from the web app) as mesh bodies: one new component per part, named after the
# file, laid out in rows by role (shells, board, cage, clips, pins, other). Optionally imports the
# preview/ STLs (silicone, cast, masters in the mold frame) and converts the small parts (clips,
# pins) to solid BRep bodies so you can edit them (fillets, text, tolerances...).
#
# INSTALL
#   1. Copy the whole folder "MeltemiImportMoldParts" (this .py + the .manifest) anywhere.
#   2. Fusion: Utilities > ADD-INS > Scripts and Add-Ins (Shift+S) > Scripts tab >
#      the green "+" (or "Script or add-in from device") > select the MeltemiImportMoldParts folder.
#   3. Select "MeltemiImportMoldParts" in the list and press Run.
#   Works in parametric (history) and direct-modeling designs. Units in the STLs are millimetres.
#
# File naming understood: NN_<id>[_xQTY].stl, e.g. 01_shellA.stl, 05_clip_silicone_x6.stl.
# Quantity is shown in the component name ("clip_silicone x6"); only one copy is imported.
#
# License: MIT (Meltemi Mold Studio).

import adsk.core
import adsk.fusion
import os
import re
import struct
import traceback

APP_NAME = 'Meltemi Mold Studio import'
GAP_MM = 15.0  # spacing between laid-out parts

# role -> (row order, substrings that identify it in the part id)
GROUPS = [
    ('Shells', ('shell', 'half', 'mold_a', 'mold_b', 'moldA', 'moldB')),
    ('Board', ('board',)),
    ('Cage', ('cage', 'support')),
    ('Clips', ('clip',)),
    ('Pins', ('pin', 'dowel')),
    ('Other', ()),
]
SMALL_GROUPS = ('Clips', 'Pins')

NAME_RE = re.compile(r'^(?:(\d+)_)?(.+?)(?:_x(\d+))?\.stl$', re.IGNORECASE)

_handlers = []


def parse_name(filename):
    """'05_clip_silicone_x6.stl' -> (5, 'clip_silicone', 6)"""
    m = NAME_RE.match(filename)
    if not m:
        return 0, os.path.splitext(filename)[0], 1
    return int(m.group(1) or 0), m.group(2), int(m.group(3) or 1)


def group_of(part_id):
    low = part_id.lower()
    for name, keys in GROUPS:
        if any(k.lower() in low for k in keys):
            return name
    return 'Other'


def stl_bbox_mm(path):
    """Axis-aligned bounding box of a binary or ASCII STL (mm) without importing it."""
    with open(path, 'rb') as f:
        data = f.read()
    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3
    n = struct.unpack_from('<I', data, 80)[0] if len(data) >= 84 else -1
    if n >= 0 and 84 + 50 * n == len(data):
        for rec in struct.iter_unpack('<12fH', data[84:84 + 50 * n]):
            for v in range(3):
                for a in range(3):
                    c = rec[3 + v * 3 + a]
                    if c < lo[a]:
                        lo[a] = c
                    if c > hi[a]:
                        hi[a] = c
    else:
        for m in re.finditer(rb'vertex\s+(\S+)\s+(\S+)\s+(\S+)', data):
            for a in range(3):
                c = float(m.group(a + 1))
                lo[a] = min(lo[a], c)
                hi[a] = max(hi[a], c)
    if lo[0] == float('inf'):
        return [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    return lo, hi


def translation(x_mm, y_mm, z_mm):
    m = adsk.core.Matrix3D.create()
    m.translation = adsk.core.Vector3D.create(x_mm / 10.0, y_mm / 10.0, z_mm / 10.0)  # API units = cm
    return m


def import_mesh(design, comp, path):
    """Add an STL as mesh bodies to comp (handles parametric designs via a base feature)."""
    units = adsk.fusion.MeshUnits.MillimeterMeshUnit
    if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
        base = comp.features.baseFeatures.add()
        base.startEdit()
        try:
            bodies = comp.meshBodies.add(path, units, base)
        finally:
            base.finishEdit()
    else:
        bodies = comp.meshBodies.add(path, units)
    return bodies


def convert_to_brep(design, comp):
    """Convert all mesh bodies of comp to BRep. Uses MeshConvertFeatures (Fusion 2025+ API);
    returns True on success, False when the API is unavailable or the conversion fails."""
    try:
        meshes = [comp.meshBodies.item(i) for i in range(comp.meshBodies.count)]
        if not meshes:
            return False
        feats = comp.features.meshConvertFeatures
        inp = None
        coll = adsk.core.ObjectCollection.create()
        for m in meshes:
            coll.add(m)
        for arg in (coll, meshes):
            try:
                inp = feats.createInput(arg)
                if inp:
                    break
            except Exception:
                inp = None
        if not inp:
            return False
        if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
            try:
                inp.meshConvertOperationType = adsk.fusion.MeshConvertOperationTypes.ParametricFeatureMeshConvertOperationType
            except Exception:
                pass
        # prefer "prismatic" (merges coplanar facets into planar faces) when available
        try:
            inp.meshConvertMethodType = adsk.fusion.MeshConvertMethodTypes.PrismaticMeshConvertMethodType
        except Exception:
            pass
        feats.add(inp)
        return comp.bRepBodies.count > 0
    except Exception:
        return False


def collect(folder):
    parts = []
    for fn in sorted(os.listdir(folder)):
        if fn.lower().endswith('.stl') and os.path.isfile(os.path.join(folder, fn)):
            idx, pid, qty = parse_name(fn)
            parts.append({'file': os.path.join(folder, fn), 'name': fn, 'index': idx, 'id': pid,
                          'qty': qty, 'group': group_of(pid)})
    return parts


def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design:
            ui.messageBox('Open or create a Design first (Fusion Design workspace).', APP_NAME)
            return

        dlg = ui.createFolderDialog()
        dlg.title = 'Select a Meltemi Mold Studio export folder (with NN_<part>.stl files)'
        if dlg.showDialog() != adsk.core.DialogResults.DialogOK:
            return
        folder = dlg.folder
        parts = collect(folder)
        prev_dir = os.path.join(folder, 'preview')
        previews = collect(prev_dir) if os.path.isdir(prev_dir) else []
        if not parts and not previews:
            ui.messageBox('No .stl files found in\n' + folder, APP_NAME)
            return

        yes = adsk.core.DialogResults.DialogYes
        with_previews = False
        if previews:
            with_previews = ui.messageBox(
                'Also import the %d preview STL(s) (silicone, cast, masters - mold frame, not for printing)?' % len(previews),
                APP_NAME, adsk.core.MessageBoxButtonTypes.YesNoButtonType) == yes
        small = [p for p in parts if p['group'] in SMALL_GROUPS]
        to_brep = False
        if small:
            to_brep = ui.messageBox(
                'Convert the %d small part(s) (clips, pins) to solid BRep bodies?\n'
                '(Needs a recent Fusion version; shells and boards stay meshes - they are too dense.)' % len(small),
                APP_NAME, adsk.core.MessageBoxButtonTypes.YesNoButtonType) == yes

        root = design.rootComponent
        kit_name = os.path.basename(os.path.normpath(folder)) or 'mold kit'
        progress = ui.createProgressDialog()
        progress.isBackgroundTranslucent = False
        progress.show(APP_NAME, 'Importing %v of %m', 0, len(parts) + (len(previews) if with_previews else 0), 1)

        # Lay out in rows by group (rows along -Y, parts along +X), each part on z = 0.
        row_y = 0.0
        done = 0
        failed = []
        converted = 0
        for gname, _keys in GROUPS:
            row = [p for p in parts if p['group'] == gname]
            if not row:
                continue
            x = 0.0
            row_depth = 0.0
            for p in row:
                if progress.wasCancelled:
                    break
                lo, hi = stl_bbox_mm(p['file'])
                size = [hi[i] - lo[i] for i in range(3)]
                # place the part's bbox min corner at (x, row_y - depth, 0)
                occ = root.occurrences.addNewComponent(
                    translation(x - lo[0], row_y - size[1] - lo[1], -lo[2]))
                comp = occ.component
                label = p['id'] + (' x%d' % p['qty'] if p['qty'] > 1 else '')
                comp.name = '%s - %s' % (gname[:-1] if gname.endswith('s') else gname, label)
                try:
                    import_mesh(design, comp, p['file'])
                    if to_brep and gname in SMALL_GROUPS and convert_to_brep(design, comp):
                        converted += 1
                except Exception:
                    failed.append(p['name'])
                x += size[0] + GAP_MM
                row_depth = max(row_depth, size[1])
                done += 1
                progress.progressValue = done
                adsk.doEvents()
            row_y -= row_depth + GAP_MM

        if with_previews and not progress.wasCancelled:
            # Previews keep their mold-frame coordinates; shifted beside the laid-out kit.
            occ = root.occurrences.addNewComponent(translation(-400.0, 0.0, 0.0))
            pv = occ.component
            pv.name = 'Preview (mold frame) - ' + kit_name
            for p in previews:
                if progress.wasCancelled:
                    break
                try:
                    sub = pv.occurrences.addNewComponent(adsk.core.Matrix3D.create()).component
                    sub.name = p['id']
                    import_mesh(design, sub, p['file'])
                except Exception:
                    failed.append('preview/' + p['name'])
                done += 1
                progress.progressValue = done
                adsk.doEvents()

        progress.hide()
        msg = 'Imported %d part(s) from\n%s' % (done - len(failed), folder)
        if to_brep:
            msg += '\n\nConverted to BRep: %d of %d small part(s).' % (converted, len(small))
            if converted < len(small):
                msg += '\n(Right-click a mesh body > Mesh to BRep / MESH > MODIFY > Convert Mesh to do it manually.)'
        if failed:
            msg += '\n\nFailed: ' + ', '.join(failed)
        msg += '\n\nShells are already in print orientation (upright). Quantities are in the component names.'
        app.activeViewport.fit()
        ui.messageBox(msg, APP_NAME)
    except Exception:
        if ui:
            ui.messageBox('Failed:\n{}'.format(traceback.format_exc()), APP_NAME)


def stop(context):
    pass
