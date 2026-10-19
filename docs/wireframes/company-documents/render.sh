# Re-render the wireframe PNGs: bash render.sh "$(pwd)" (needs google-chrome + python3-PIL)
set -e
cd "$1"
r(){ google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=$2,$3 --screenshot=$PWD/$1.png file://$PWD/$1.html >/dev/null 2>&1; }
r desktop-company 1280 1800; r packet-flow 1280 1000; r phone-company 390 2000; r phone-documents-tab 390 1400
python3 - <<'PY'
from PIL import Image, ImageChops
import glob
for f in glob.glob('*.png'):
    im=Image.open(f).convert('RGB'); bg=Image.new('RGB',im.size,im.getpixel((im.width-2,im.height-2)))
    bbox=ImageChops.difference(im,bg).getbbox()
    if bbox: im=im.crop((0,0,im.width,min(im.height,bbox[3]+40)))
    im.save(f,optimize=True); print(f,im.size)
PY
