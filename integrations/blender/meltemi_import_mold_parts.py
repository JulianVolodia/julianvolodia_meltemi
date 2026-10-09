# Meltemi Mold Studio -> Blender (4.x, also 3.6) importer.
#
# Imports every STL of a Meltemi Mold Studio export folder (CLI output folder or the unzipped
# "Export ZIP") into a collection "Meltemi - <folder>", with sub-collections per role (Shells,
# Board, Cage, Clips, Pins, Other, Preview) and coloured materials by role, laid out in rows on the
# XY plane (parts stay in print orientation). preview/*.stl (silicone, cast, masters) are imported
# in their mold-frame coordinates next to the kit.
#
# USE
#   a) GUI: Scripting workspace > Open this file > Run Script -> a folder browser opens
#      (the operator is also added to File > Import > "Meltemi mold kit (folder of STL)").
#   b) Command line:
#        blender --python meltemi_import_mold_parts.py -- /path/to/out/candles
#      (add --background and a save path to batch-convert:  -- /path/to/kit /path/to/kit.blend)
#
# Units: STLs are millimetres; the scene is switched to millimetres (unit scale 0.001), so
# 1 Blender unit = 1 mm and dimensions read correctly in the N panel.
#
# License: MIT (Meltemi Mold Studio).

import os
import re
import sys

import bpy
from bpy.props import BoolProperty, StringProperty

bl_info = {
    "name": "Meltemi Mold Studio kit importer",
    "author": "Meltemi Mold Studio",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "File > Import > Meltemi mold kit",
    "description": "Import a folder of Meltemi Mold Studio STL parts with role colours",
    "category": "Import-Export",
}

GAP = 15.0  # mm between laid-out parts

# group name, id substrings, RGBA colour (reference footage palette)
GROUPS = [
    ("Shells", ("shell", "half"), (0.85, 0.62, 0.12, 1.0)),
    ("Board", ("board",), (0.95, 0.50, 0.08, 1.0)),
    ("Cage", ("cage", "support"), (0.80, 0.68, 0.25, 1.0)),
    ("Clips", ("clip",), (0.20, 0.70, 0.32, 1.0)),
    ("Pins", ("pin", "dowel"), (0.10, 0.75, 0.85, 1.0)),
    ("Silicone", ("silicone",), (0.20, 0.42, 0.95, 0.65)),
    ("Cast", ("cast", "wax", "resin"), (0.80, 0.14, 0.10, 1.0)),
    ("Masters", ("master",), (0.60, 0.60, 0.62, 1.0)),
    ("Other", (), (0.55, 0.55, 0.55, 1.0)),
]
COLORS = {g[0]: g[2] for g in GROUPS}

NAME_RE = re.compile(r"^(?:(\d+)_)?(.+?)(?:_x(\d+))?\.stl$", re.IGNORECASE)


def parse_name(filename):
    """'05_clip_silicone_x6.stl' -> (5, 'clip_silicone', 6)"""
    m = NAME_RE.match(filename)
    if not m:
        return 0, os.path.splitext(filename)[0], 1
    return int(m.group(1) or 0), m.group(2), int(m.group(3) or 1)


def group_of(part_id, preview=False):
    low = part_id.lower()
    # in the preview folder "cast" means the cast part; in the kit, "clip_cast"/"pin_cast" are clips/pins
    for name, keys, _ in GROUPS:
        if not preview and name in ("Silicone", "Cast", "Masters"):
            continue
        if any(k in low for k in keys):
            return name
    return "Other"


def material_for(group):
    name = "Meltemi " + group
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        rgba = COLORS.get(group, COLORS["Other"])
        mat.diffuse_color = rgba  # solid-mode viewport colour
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgba
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = 0.55
            if rgba[3] < 1.0 and "Alpha" in bsdf.inputs:
                bsdf.inputs["Alpha"].default_value = rgba[3]
                try:
                    mat.blend_method = "BLEND"
                except Exception:
                    pass
    return mat


def child_collection(parent, name):
    full = parent.name + " / " + name
    col = bpy.data.collections.get(full)
    if col is None:
        col = bpy.data.collections.new(full)
        parent.children.link(col)
    return col


def import_stl(path):
    """Import one STL, return the new objects (Blender 4.2+ wm.stl_import, else the legacy add-on)."""
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "stl_import"):
        try:
            bpy.ops.wm.stl_import(filepath=path)
        except Exception:
            bpy.ops.import_mesh.stl(filepath=path)
    else:
        bpy.ops.import_mesh.stl(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def move_to(obj, col):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    col.objects.link(obj)


def world_bbox(obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices] if obj.type == "MESH" and obj.data.vertices else []
    if not pts:
        return (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)
    lo = tuple(min(p[i] for p in pts) for i in range(3))
    hi = tuple(max(p[i] for p in pts) for i in range(3))
    return lo, hi


def collect(folder, preview=False):
    out = []
    if not os.path.isdir(folder):
        return out
    for fn in sorted(os.listdir(folder)):
        if fn.lower().endswith(".stl"):
            idx, pid, qty = parse_name(fn)
            out.append({"path": os.path.join(folder, fn), "file": fn, "index": idx, "id": pid, "qty": qty,
                        "group": group_of(pid, preview)})
    return out


def import_kit(folder, with_previews=True, set_units=True):
    folder = os.path.abspath(folder)
    parts = collect(folder)
    previews = collect(os.path.join(folder, "preview"), preview=True) if with_previews else []
    if not parts and not previews:
        raise RuntimeError("No .stl files in " + folder)
    scene = bpy.context.scene
    if set_units:
        scene.unit_settings.system = "METRIC"
        scene.unit_settings.scale_length = 0.001
        scene.unit_settings.length_unit = "MILLIMETERS"
    kit = bpy.data.collections.new("Meltemi - " + (os.path.basename(folder) or "kit"))
    scene.collection.children.link(kit)

    row_y = 0.0
    count = 0
    for gname, _k, _c in GROUPS:
        row = [p for p in parts if p["group"] == gname]
        if not row:
            continue
        col = child_collection(kit, gname)
        mat = material_for(gname)
        x = 0.0
        depth = 0.0
        for p in row:
            for obj in import_stl(p["path"]):
                move_to(obj, col)
                obj.name = p["id"] + (" x%d" % p["qty"] if p["qty"] > 1 else "")
                obj["meltemi_quantity"] = p["qty"]
                obj["meltemi_file"] = p["file"]
                obj.data.materials.clear()
                obj.data.materials.append(mat)
                lo, hi = world_bbox(obj)
                obj.location.x += x - lo[0]
                obj.location.y += row_y - hi[1]
                obj.location.z += -lo[2]
                x += (hi[0] - lo[0]) + GAP
                depth = max(depth, hi[1] - lo[1])
                count += 1
        row_y -= depth + GAP

    if previews:
        col = child_collection(kit, "Preview (mold frame)")
        for p in previews:
            for obj in import_stl(p["path"]):
                move_to(obj, col)
                obj.name = "preview " + p["id"]
                obj.data.materials.clear()
                obj.data.materials.append(material_for(p["group"]))
                obj.location.x -= 400.0  # beside the laid-out kit, mold-frame coordinates kept
                count += 1
    return count


class MELTEMI_OT_import_mold_parts(bpy.types.Operator):
    """Import a Meltemi Mold Studio export folder (STL parts) with role colours"""

    bl_idname = "meltemi.import_mold_parts"
    bl_label = "Import Meltemi mold kit"
    bl_options = {"REGISTER", "UNDO"}

    directory: StringProperty(subtype="DIR_PATH")
    with_previews: BoolProperty(name="Import previews (silicone, cast, masters)", default=True)
    set_units: BoolProperty(name="Set scene units to millimetres", default=True)

    def execute(self, context):
        try:
            n = import_kit(self.directory, self.with_previews, self.set_units)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report({"INFO"}, "Imported %d object(s) from %s" % (n, self.directory))
        return {"FINISHED"}

    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}


def menu_func(self, context):
    self.layout.operator(MELTEMI_OT_import_mold_parts.bl_idname, text="Meltemi mold kit (folder of STL)")


def register():
    bpy.utils.register_class(MELTEMI_OT_import_mold_parts)
    bpy.types.TOPBAR_MT_file_import.append(menu_func)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_func)
    bpy.utils.unregister_class(MELTEMI_OT_import_mold_parts)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if argv:
        n = import_kit(argv[0])
        print("Meltemi: imported %d object(s) from %s" % (n, argv[0]))
        if len(argv) > 1:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(argv[1]))
            print("Meltemi: saved " + argv[1])
    else:
        try:
            unregister()
        except Exception:
            pass
        register()
        if not bpy.app.background:
            bpy.ops.meltemi.import_mold_parts("INVOKE_DEFAULT")
