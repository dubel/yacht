#!/usr/bin/env bash
# side by side: .shots/NAME-three.png | .shots/NAME-unity.png → .shots/NAME-cmp.png
set -e
cd "$(dirname "$0")/../.."
n=$1
magick \( ".shots/$n-three.png" -gravity north -fill white -undercolor '#0008' -pointsize 22 -annotate +0+8 'three.js' \) \
       \( ".shots/$n-unity.png" -gravity north -fill white -undercolor '#0008' -pointsize 22 -annotate +0+8 'Unity' \) +append -resize 1600x ".shots/$n-cmp.png"
echo ".shots/$n-cmp.png"
