"""
Convert the ram illustration for use as app icon:
- Makes white background transparent
- Tints the ram to #e8d5b0 (warm off-white/linen) for contrast on #0b0b0b background
- Outputs a square PNG cropped tightly around the ram

Usage: python process_icon.py <input_image_path>
"""
from PIL import Image
import sys, os

INPUT  = sys.argv[1]
OUTPUT = os.path.join(os.path.dirname(INPUT), "stiq_icon_processed.png")

# Icon tint colour (warm linen — readable on near-black #0b0b0b, softer than pure white)
TINT = (232, 213, 176, 255)

img = Image.open(INPUT).convert("RGBA")
pixels = img.load()

# Threshold: treat near-white as background, near-black as icon
WHITE_THRESH = 200
BLACK_THRESH = 80

new_pixels = []
for y in range(img.height):
    for x in range(img.width):
        r, g, b, a = pixels[x, y]
        brightness = (r + g + b) / 3
        if brightness > WHITE_THRESH:
            # Background — make transparent
            pixels[x, y] = (0, 0, 0, 0)
        elif brightness < BLACK_THRESH:
            # Dark icon pixel — tint it
            pixels[x, y] = TINT
        else:
            # Mid-tone — tint proportionally
            ratio = 1 - (brightness - BLACK_THRESH) / (WHITE_THRESH - BLACK_THRESH)
            pixels[x, y] = (
                int(TINT[0] * ratio),
                int(TINT[1] * ratio),
                int(TINT[2] * ratio),
                int(255 * ratio),
            )

# Crop to bounding box of non-transparent pixels
bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)

# Add small padding (5% each side)
pad = int(max(img.width, img.height) * 0.05)
padded = Image.new("RGBA", (img.width + 2*pad, img.height + 2*pad), (0, 0, 0, 0))
padded.paste(img, (pad, pad))

padded.save(OUTPUT, "PNG")
print(f"Saved: {OUTPUT}  ({padded.width}x{padded.height})")
