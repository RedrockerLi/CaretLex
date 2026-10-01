#!/usr/bin/env python3
"""Export Linux PNG icons from logo-icon-dark.svg with librsvg and Cairo."""
from __future__ import annotations

import ctypes
import ctypes.util
import re
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "logo-icon-dark.svg"
SIZES = (128, 256, 512)


class Rectangle(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_double),
        ("y", ctypes.c_double),
        ("width", ctypes.c_double),
        ("height", ctypes.c_double),
    ]


def resolved_svg(source: Path) -> str:
    svg = source.read_text(encoding="utf-8")
    style_match = re.search(r"<style>(.*?)</style>", svg, flags=re.DOTALL)
    if not style_match:
        return svg
    root_match = re.search(r":root\s*\{(.*?)\}", style_match.group(1), flags=re.DOTALL)
    if not root_match:
        return svg
    variables = dict(re.findall(r"--([\w-]+)\s*:\s*([^;]+)", root_match.group(1)))

    def substitute(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in variables:
            raise ValueError(f"undefined SVG custom property: --{name}")
        return variables[name].strip()

    svg = re.sub(r"var\(--([\w-]+)\)", substitute, svg)
    return re.sub(r"\s*<style>.*?</style>", "", svg, flags=re.DOTALL)


def render_png(svg_text: str, target: Path, width: int, height: int | None = None) -> None:
    height = width if height is None else height
    rsvg_path = ctypes.util.find_library("rsvg-2")
    cairo_path = ctypes.util.find_library("cairo")
    gobject_path = ctypes.util.find_library("gobject-2.0")
    if not rsvg_path or not cairo_path or not gobject_path:
        raise RuntimeError("librsvg, Cairo and GObject are required to export PNG icons")

    rsvg = ctypes.CDLL(rsvg_path)
    cairo = ctypes.CDLL(cairo_path)
    gobject = ctypes.CDLL(gobject_path)
    rsvg.rsvg_handle_new_from_file.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    rsvg.rsvg_handle_new_from_file.restype = ctypes.c_void_p
    rsvg.rsvg_handle_render_document.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(Rectangle),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    rsvg.rsvg_handle_render_document.restype = ctypes.c_int
    cairo.cairo_image_surface_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    cairo.cairo_image_surface_create.restype = ctypes.c_void_p
    cairo.cairo_create.argtypes = [ctypes.c_void_p]
    cairo.cairo_create.restype = ctypes.c_void_p
    cairo.cairo_surface_write_to_png.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    cairo.cairo_surface_write_to_png.restype = ctypes.c_int
    cairo.cairo_destroy.argtypes = [ctypes.c_void_p]
    cairo.cairo_surface_destroy.argtypes = [ctypes.c_void_p]
    gobject.g_object_unref.argtypes = [ctypes.c_void_p]

    with tempfile.NamedTemporaryFile(mode="w", suffix=".svg", encoding="utf-8") as prepared:
        prepared.write(svg_text)
        prepared.flush()
        error = ctypes.c_void_p()
        handle = rsvg.rsvg_handle_new_from_file(prepared.name.encode(), ctypes.byref(error))
        if not handle:
            raise RuntimeError(f"librsvg could not load {SOURCE.name}")
        surface = cairo.cairo_image_surface_create(0, width, height)  # CAIRO_FORMAT_ARGB32
        context = cairo.cairo_create(surface)
        viewport = Rectangle(0, 0, width, height)
        try:
            rendered = rsvg.rsvg_handle_render_document(handle, context, ctypes.byref(viewport), ctypes.byref(error))
            if not rendered:
                raise RuntimeError(f"librsvg could not render {SOURCE.name} at {width} × {height}px")
            status = cairo.cairo_surface_write_to_png(surface, str(target).encode())
            if status:
                raise RuntimeError(f"Cairo could not write {target.name}: status {status}")
        finally:
            cairo.cairo_destroy(context)
            cairo.cairo_surface_destroy(surface)
            gobject.g_object_unref(handle)


def main() -> None:
    svg_text = resolved_svg(SOURCE)
    for size in SIZES:
        output = ROOT / f"app-icon-{size}.png"
        render_png(svg_text, output, size)
        print(f"{output.name}: {size} × {size}")
    (ROOT / "app-icon.png").write_bytes((ROOT / "app-icon-512.png").read_bytes())
    print("app-icon.png: copied from app-icon-512.png")


if __name__ == "__main__":
    main()
