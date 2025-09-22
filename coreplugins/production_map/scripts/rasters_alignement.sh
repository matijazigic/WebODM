#!/bin/bash
 

#set -e  # Stop on errors

ref=$1
input=$2
output=$3

read px py <<< $(gdalinfo "$ref" | grep "Pixel Size" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1, $2*-1}')

rotation=$(gdalinfo "$ref" | grep "GeoTransform" | grep -v "0," | grep -v ",0")

if [ -n "$rotation" ]; then
  # Extract all 4 corners
  ulx=$(gdalinfo "$ref" | grep "Upper Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1}')
  uly=$(gdalinfo "$ref" | grep "Upper Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $2}')
  llx=$(gdalinfo "$ref" | grep "Lower Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1}')
  lly=$(gdalinfo "$ref" | grep "Lower Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $2}')
  urx=$(gdalinfo "$ref" | grep "Upper Right" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1}')
  ury=$(gdalinfo "$ref" | grep "Upper Right" | sed 's/[^0-9\.\-]/ /g' | awk '{print $2}')
  lrx=$(gdalinfo "$ref" | grep "Lower Right" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1}')
  lry=$(gdalinfo "$ref" | grep "Lower Right" | sed 's/[^0-9\.\-]/ /g' | awk '{print $2}')
  # Calculate min/max
  xmin=$(echo "$ulx $llx $urx $lrx" | tr ' ' '\n' | sort -n | head -1)
  xmax=$(echo "$ulx $llx $urx $lrx" | tr ' ' '\n' | sort -n | tail -1)
  ymin=$(echo "$uly $lly $ury $lry" | tr ' ' '\n' | sort -n | head -1)
  ymax=$(echo "$uly $lly $ury $lry" | tr ' ' '\n' | sort -n | tail -1)

else
  xmin=$(gdalinfo "$ref" | grep "Upper Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1}')
  ymax=$(gdalinfo "$ref" | grep "Upper Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $2}')
  xmax=$(gdalinfo "$ref" | grep "Upper Right" | sed 's/[^0-9\.\-]/ /g' | awk '{print $1}')
  ymin=$(gdalinfo "$ref" | grep "Lower Left" | sed 's/[^0-9\.\-]/ /g' | awk '{print $2}')
fi

if [ -f "$output" ]; then
  rm "$output"
fi

gdalwarp -tr $px $py -te $xmin $ymin $xmax $ymax -tap \
  -r bilinear -dstnodata -9999 "$input" "$output"
