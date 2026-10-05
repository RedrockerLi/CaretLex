"""Drive the actual GTK file chooser in the isolated Xvfb smoke session."""
import ctypes
import sys
import re
import subprocess
import time

x11 = ctypes.CDLL('libX11.so.6')
xtest = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_uint
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XFlush.argtypes = [ctypes.c_void_p]
xtest.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError('No isolated display')

def key(name, down):
    code = x11.XKeysymToKeycode(display, x11.XStringToKeysym(name.encode('ascii')))
    if not code:
        raise RuntimeError(f'No key for {name}')
    xtest.XTestFakeKeyEvent(display, code, down, 0)
    x11.XFlush(display)

def press(name):
    key(name, 1)
    key(name, 0)

deadline = time.monotonic() + 8
windows = []
while not windows and time.monotonic() < deadline:
    tree = subprocess.check_output(['xwininfo', '-root', '-tree'], text=True)
    windows = re.findall(r'(0x[0-9a-f]+) "选择同步设置文件位置"', tree)
    if not windows:
        time.sleep(0.1)
if not windows:
    raise RuntimeError('The real GTK chooser is not visible: ' + tree)
window = int(windows[-1], 16)
x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x11.XSetInputFocus(display, window, 1, 0)
x11.XFlush(display)
time.sleep(0.2)
key('Control_L', 1)
press('l')
key('Control_L', 0)
time.sleep(0.3)
key('Control_L', 1)
press('a')
key('Control_L', 0)
for character in sys.argv[1]:
    if character not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.' :
        raise RuntimeError('Smoke chooser paths must use supported ASCII characters')
    shifted = character.isupper() or character == '_'
    if shifted:
        key('Shift_L', 1)
    press({'/': 'slash', '.': 'period', '-': 'minus', '_': 'minus'}.get(character, character.lower()))
    if shifted:
        key('Shift_L', 0)
    time.sleep(0.005)
press('Return')
time.sleep(0.5)
press('Return')
