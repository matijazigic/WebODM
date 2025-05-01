import subprocess
import rasterio
import numpy as np
import cv2
import os
import re
import sys

import logging

logger = logging.getLogger('app.logger')

class RasterAveragingProcessor:
    def __init__(self):
        pass
    
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass

    @staticmethod
    def run_command(command):
        """Run a shell command and handle errors."""
        try:
            subprocess.run(command, shell=True, check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error: Command failed with exit code {e.returncode}")
            sys.exit(1)

    @staticmethod
    def extract_extent_and_pixel_size(ref):
        """Extract extent and pixel size from the reference raster using gdalinfo."""
        gdalinfo_output = subprocess.check_output(f"gdalinfo {ref}", shell=True, text=True)

        # Extract pixel size
        pat = re.compile(r"""Pixel\s+Size\s*=\s*\(\s*
                            ([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
                            \s*,\s*
                            ([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
                            \s*\)""", re.VERBOSE)
        m = pat.search(gdalinfo_output)
        if not m:
            raise ValueError("Could not extract pixel size from gdalinfo output.")
        px, py = map(float, m.groups())

        # Extract extent
        pat_ul = re.compile(r"""
        Upper\s+Left\s*             
        \(\s*([+-]?\d+(?:\.\d+)?)    
        \s*,\s*
        ([+-]?\d+(?:\.\d+)?)         
        \s*\)
        """, re.VERBOSE)
        m = pat_ul.search(gdalinfo_output)
        if not m:
            raise ValueError("Could not extract Upper Left corner from gdalinfo output.")
        x_ul, y_ul = map(float, m.groups())

        pat_lr = re.compile(r"""
        Lower\s+Right\s*
        \(\s*([+-]?\d+(?:\.\d+)?)    
        \s*,\s*
        ([+-]?\d+(?:\.\d+)?)      
        \s*\)
        """, re.VERBOSE)
        m = pat_lr.search(gdalinfo_output)
        if not m:
            raise ValueError("Could not extract Lower Right corner from gdalinfo output.")
        x_lr, y_lr = map(float, m.groups())

        xmin, ymax = float(x_ul), float(y_ul)
        xmax, ymin = float(x_lr), float(y_lr)

        return px, py, xmin, ymin, xmax, ymax

    def align_rasters(self, input_rasters, output_folder):
        """
        Align multiple input rasters to the grid of the first raster in the list.

        Args:
            input_rasters (list): List of input raster paths. The first raster is treated as the reference.
            output_folder (str): Folder to save the aligned rasters.

        Returns:
            list: List of paths to the aligned rasters.
        """
        if not os.path.exists(output_folder):
            os.makedirs(output_folder)

        ref = input_rasters[0]
        px, py, xmin, ymin, xmax, ymax = self.extract_extent_and_pixel_size(ref)

        aligned_rasters = []
        for input_raster in input_rasters:
            output_raster = f"{output_folder}/{os.path.basename(input_raster).replace('.tif', '_aligned.tif')}"
            aligned_rasters.append(output_raster)

            gdalwarp_command = (
                f"gdalwarp -te {xmin} {ymin} {xmax} {ymax} -tr {px} {py} -tap "
                f"-r near -dstnodata -9999 -overwrite {input_raster} {output_raster}"
            )
            logger.info(f"Running: {gdalwarp_command}")
            self.run_command(gdalwarp_command)

        return aligned_rasters

    def average_rasters(self, input_rasters, output_path):
        """
        Averages multiple raster files and writes the result to a new file.

        Args:
            input_rasters (list): List of paths to input rasters.
            output_path (str): Path to the output raster.
        """
        with rasterio.open(input_rasters[0]) as ref_raster:
            # Initialize an array to accumulate the sum of rasters
            sum_array = np.zeros((ref_raster.count, ref_raster.height, ref_raster.width), dtype="float32")
            mask = None

            for raster_path in input_rasters:
                with rasterio.open(raster_path) as src:
                    assert src.shape == ref_raster.shape, "All rasters must have the same dimensions"
                    data = src.read(masked=True).astype("float32")
                    sum_array += data
                    if mask is None:
                        mask = data.mask
                    else:
                        mask |= data.mask

            avg_array = (sum_array / len(input_rasters)).astype("uint8")
            avg_array = np.ma.array(avg_array, mask=mask).filled(0)

            profile = ref_raster.profile.copy()
            profile.update(
                driver="GTiff",
                dtype="uint8",
                nodata=255,
                # compress="LZW"
            )

        with rasterio.open(output_path, "w", **profile) as dst:
            dst.write(avg_array)

class ProductionMapGenerator:
    def __init__(self, input_file_path, downsample_size, num_of_zones, output_file_path):
        self.input_file_path = input_file_path
        self.output_file_path = output_file_path
        self.downsample_size = downsample_size
        self.num_of_clusters = num_of_zones
        
        try:
            self.dataset = rasterio.open(input_file_path)
        except rasterio.errors.RasterioIOError as e:
            logger.error(f"Error opening file: {e}")
            raise

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.dataset:
            self.dataset.close()

    def load_image(self, dataset):
        """Loads and normalizes the raster image."""
        image = dataset.read([1, 2, 3])
        image = np.dstack(image)

        #Normalize to 0-255 if needed
        if image.dtype != np.uint8:
            image = cv2.normalize(image, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)

        return image

    def upsample_image(self, image, orig_height, orig_width):
        """
        Upsamples the given image using OpenCV's resize function.

        Args:
            image (np.ndarray): The image to upsample.
            scale_factor (float): The factor by which to scale the image (e.g., 2 for 2x upsampling).

        Returns:
            np.ndarray: The upsampled image.
        """

        if len(image.shape) == 3:
            upsampled_image = cv2.resize(image, (orig_width, orig_height), interpolation=cv2.INTER_NEAREST)
        else:
            upsampled_image = cv2.resize(image, (orig_width, orig_height), interpolation=cv2.INTER_NEAREST)

        return upsampled_image

    def downsample_image(self, path, downsample_resolution = 5):
        import subprocess

        path_without_ext, extension = os.path.splitext(path)
        output_name = path_without_ext + "_downsampled.tif"
        
        if os.path.exists(output_name):
            os.remove(output_name)

        # Define the target resolution
        x_res = downsample_resolution  # Pixel resolution in X direction (meters or degrees)
        y_res = downsample_resolution  # Pixel resolution in Y direction (meters or degrees)
        resample_method = "bilinear"  # Resampling method

        # Construct the command
        cmd = [
            "gdalwarp",
            "-tr", str(x_res), str(y_res),
            "-r", resample_method, 
            path,
            output_name
        ]

        subprocess.run(cmd, check=True)
        
        try:
            self.dataset_downsampled = rasterio.open(output_name)
        except rasterio.errors.RasterioIOError as e:
            logger.error(f"Error opening file: {e}")
            raise
        
        return self.load_image(self.dataset_downsampled)
    
    def convert_to_label_index_image(self, classified_image):
        """
        Converts the classified image into a label index image where each unique color is assigned a unique label.

        Args:
            classified_image (np.ndarray): The classified image with unique colors.

        Returns:
            np.ndarray: The label index image.
        """
        # Ensure the classified image is in the correct format (e.g., uint8)
        if classified_image.dtype != np.uint8:
            classified_image = classified_image.astype(np.uint8)

        # Identify unique colors in the classified image
        unique_colors = np.unique(classified_image.reshape(-1, classified_image.shape[2]), axis=0)

        # Create a mapping from unique colors to labels
        color_to_label = {tuple(color): label for label, color in enumerate(unique_colors)}

        # Create the label index image
        label_index_image = np.zeros(classified_image.shape[:2], dtype=np.uint8)
        for color, label in color_to_label.items():
            mask = np.all(classified_image == color, axis=-1)
            label_index_image[mask] = label
            
        label_to_color = {label: color for color, label in color_to_label.items()}

        return label_index_image, label_to_color
        
    def get_largest_contour_mask(self, image):
        """Find the largest contour and create a mask for it."""
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        _, binary_mask = cv2.threshold(gray, 55, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        # Find the largest contour
        largest_contour = max(contours, key=cv2.contourArea)

        # Create a blank mask
        contour_mask = np.zeros_like(gray, dtype=np.uint8)
        
        # Fill the largest contour
        cv2.drawContours(contour_mask, [largest_contour], -1, 255, thickness=cv2.FILLED)

        return contour_mask

    def determine_clusters(self, image, contour_mask, num_clusters):
        """
        Finds the k dominant colors using K-Means clustering inside the largest contour.
        Uses the CIE-LAB color space for better perceptual clustering.
        """
        lab_image = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)

        kernel = np.ones((3, 3), np.uint8)
        refined_mask = cv2.erode(contour_mask, kernel, iterations=1)      

        inside_indices = np.where(refined_mask == 255)
        inside_pixels_lab = lab_image[inside_indices]  # shape: (N, 3)

        if len(inside_pixels_lab) < num_clusters:
            print("Not enough pixels inside the contour for clustering.")
            return np.array([[0, 0, 0]] * num_clusters, dtype=np.uint8)

        data = inside_pixels_lab.astype(np.float32)

        #Apply OpenCV K-Means Clustering
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.2)
        _, labels, centers = cv2.kmeans(data, num_clusters, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)

        #Extract k dominant colors
        primary_colors_lab = centers.astype(np.uint8)
        primary_colors_rgb = cv2.cvtColor(primary_colors_lab.reshape(1, -1, 3), cv2.COLOR_LAB2RGB).reshape(-1, 3)

        return primary_colors_rgb
    
    # def determine_contours(self, image, primary_colors, color_threshold = 30):
    #     """
    #     Calculates contours based on primary color masks and displays contours over the mask.

    #     Parameters:
    #     - image: Input RGB image.
    #     - contour_mask: Binary mask for the region of interest.
    #     - primary_colors: List of RGB cluster colors.
    #     - color_threshold: Threshold for color similarity in LAB space.

    #     Returns:
    #     - contours_dict: Dictionary with primary colors as keys and lists of contours as values.
    #     """
    #     lab_image = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
    #     contours_dict = {}
    #     primary_color_masks = np.zeros((image.shape[0], image.shape[1], len(primary_colors)), dtype=np.uint8)

    #     for i, color in enumerate(primary_colors):
    #         color_lab = cv2.cvtColor(np.uint8([[color]]), cv2.COLOR_RGB2LAB)[0][0]
    #         diff = np.linalg.norm(lab_image.astype(np.int16) - color_lab.astype(np.int16), axis=2)
    #         primary_color_masks[:, :, i] = (diff < color_threshold).astype(np.uint8) * 255
            
    #         #TODO: check how to implement - trying to remove gap between contours
    #         # if i == 0:
    #         #     kernel = np.ones((3, 3), np.uint8)
    #         #     primary_color_masks[:, :, i] = cv2.dilate(primary_color_masks[:, :, i], kernel, iterations=1)

    #     for i, color in enumerate(primary_colors):
    #         contours, hierarchy = cv2.findContours(primary_color_masks[:, :, i], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    #         contours_dict[tuple(color)] = contours
    #         mask_with_contours = cv2.cvtColor(primary_color_masks[:, :, i], cv2.COLOR_GRAY2BGR) 
    #         cv2.drawContours(mask_with_contours, contours, -1, (255, 255, 0), thickness=1)

    #     return contours_dict
            
    def determine_closest_color(self, image, contour_mask, primary_colors, method="LAB"):
        """
        Classifies each pixel into the closest of the cluster colors in either LAB or HSV space.
        
        Parameters:
        - image: Input image in RGB format
        - contour_mask: Binary mask for region of interest
        - primary_colors: List of cluster colors in RGB
        - method: "LAB" (default) or "HSV" to choose the classification color space
        
        Returns:
        - Classified image with pixels mapped to the closest cluster color
        """
        
        if method.upper() == "LAB":
            color_space = cv2.COLOR_RGB2LAB
        elif method.upper() == "HSV":
            color_space = cv2.COLOR_RGB2HSV
        else:
            raise ValueError("Invalid method. Choose 'LAB' or 'HSV'.")

        # Convert primary colors to the chosen color space
        primary_colors_transformed = np.array([
            cv2.cvtColor(np.uint8([[color]]), color_space)[0, 0] for color in primary_colors
        ])
        
        transformed_image = cv2.cvtColor(image, color_space)

        output = np.zeros_like(image)

        inside_indices = np.where(contour_mask == 255)
        transformed_inside = transformed_image[inside_indices] 

        transformed_inside_expanded = transformed_inside[:, np.newaxis, :]  # Shape: (N, 1, 3)
        ref_expanded = primary_colors_transformed[np.newaxis, :, :]  # Shape: (1, k, 3)

        diff = transformed_inside_expanded.astype(np.int16) - ref_expanded.astype(np.int16)
        dist_sq = np.sum(diff**2, axis=2)  # Shape: (N, k)
        closest_indices = np.argmin(dist_sq, axis=1)  # Find closest color

        # Assign pixels to the closest cluster color
        assigned_colors = np.array([primary_colors[idx] for idx in closest_indices], dtype=np.uint8)
        output[inside_indices] = assigned_colors

        return output
    
    def apply_morphological_operators(self, image, mask, primary_colors):
        kernel = np.ones((7, 7), np.uint8)
        image[mask == 255] = cv2.morphologyEx(image, cv2.MORPH_OPEN, kernel)[mask == 255]
        image[mask == 255] = cv2.morphologyEx(image, cv2.MORPH_CLOSE, kernel)[mask == 255]

        primary_colors_transformed = np.array([
            cv2.cvtColor(np.uint8([[color]]), cv2.COLOR_RGB2LAB)[0, 0] for color in primary_colors
        ])
        
        transformed_image = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)

        # **Map each pixel back to the closest primary color**
        inside_indices = np.where(mask == 255)
        transformed_inside = transformed_image[inside_indices]

        transformed_inside_expanded = transformed_inside[:, np.newaxis, :]  # Shape: (N, 1, 3)
        ref_expanded = primary_colors_transformed[np.newaxis, :, :]  # Shape: (1, k, 3)

        diff = transformed_inside_expanded.astype(np.int16) - ref_expanded.astype(np.int16)
        dist_sq = np.sum(diff**2, axis=2)  # Shape: (N, k)
        closest_indices = np.argmin(dist_sq, axis=1)  # Find closest color

        # **Assign pixels to the closest cluster color**
        assigned_colors = np.array([primary_colors[idx] for idx in closest_indices], dtype=np.uint8)
        image[inside_indices] = assigned_colors
    
    def apply_upsamling(self, contour_dict, scale_factor):
        """
        Upsamples OpenCV contours using interpolation.

        Parameters:
        - contours (list): List of contours from `cv2.findContours()`.
        - scale_factor (float): Factor to upsample the contours.

        Returns:
        - upsampled_contours (list): List of upsampled contours.
        """
        upsampled_contours_dict = {}

        for color, contours in contour_dict.items():
            upsampled_contours = []
            for contour in contours:
                contour = np.array(contour, dtype=np.float32) * scale_factor
                upsampled_contours.append(contour.astype(np.int32))
            
            upsampled_contours_dict[color] = upsampled_contours

        return upsampled_contours_dict

    def save_raster_image(self, image, output_filename):
        """
        Saves the classified image as a GeoTIFF file, preserving the original metadata.

        Args:
            classified_image (np.ndarray): The classified image data.
            output_filename (str): The name of the output GeoTIFF file.
        """
        if not self.dataset:
            print("Dataset not loaded.")
            return

        # Ensure the classified image is in the correct format (e.g., uint8)
        if image.dtype != np.uint8:
            image = image.astype(np.uint8)

        # Get the metadata from the original dataset
        profile = self.dataset.profile

        # Update the metadata for the classified image
        profile.update({
            'dtype': image.dtype,
            'count': 3 if len(image.shape) == 3 else 1,  # Adjust count based on image shape
            'height': image.shape[0],
            'width': image.shape[1],
            'compress': 'lzw',
            'nodata': 0
        })

        # Write the classified image to a new GeoTIFF file
        with rasterio.open(output_filename, 'w', **profile) as dst:
            if len(image.shape) == 3:
                # RGB, write each band separately
                for i in range(3):
                    dst.write(image[:, :, i], i + 1)
            else:
                #single-band
                dst.write(image, 1)

    def polygonize_raster(self, raster_path, output_path, layer_name):
        """
        Polygonizes a raster file using gdal_polygonize.py.
        This utility creates vector polygons for all connected regions of pixels in the raster sharing a common pixel value. 
        Each polygon is created with an attribute indicating the pixel value of that polygon. 
        A raster mask may also be provided to determine which pixels are eligible for processing.

        Args:
            raster_path (str): Path to the input raster file.
            output_path (str): Path to the output vector file (GPKG or GeoJSON).
        """

        cmd = [
            "gdal_polygonize.py",
            raster_path,
            "-b", "1",  # Use band 1
            "-f", "GPKG",
            output_path,
            layer_name,  # layer name
            "label"  # attribute field name explicitly for labels
        ]
        
        subprocess.run(cmd, check=True)

    def add_color_based_on_label(output_path, layer_name, label_to_color):
        """
        Adds a 'color' property to the layer based on the 'label' value.

        Args:
            output_path (str): Path to the GeoPackage file.
            layer_name (str): Name of the layer to modify.
            label_to_color (dict): Mapping from label to color.
        """
        # # Define a mapping from label to color
        # label_to_color = {
        #     1: "red",
        #     2: "blue",
        #     3: "green",
        #     4: "yellow",
        #     5: "purple"
        # }

        # Add the 'color' column
        subprocess.run([
            "ogrinfo",
            output_path,
            "-sql",
            f"ALTER TABLE {layer_name} ADD COLUMN color TEXT"
        ], check=True)

        # Update the 'color' column based on the 'label' value
        for label, color in label_to_color.items():
            subprocess.run([
                "ogrinfo",
                output_path,
                "-sql",
                f"UPDATE {layer_name} SET color = '{color}' WHERE label = {label}"
            ], check=True)

    def simplify_polygons(self, input_gpkg, output_gpkg, layer_name, tolerance):
        """
        Simplifies polygon geometries in a GeoPackage file using a given tolerance while preserving topology.

        Parameters:
        - input_gpkg (str): Input file path to the original polygonized raster GeoPackage.
        - output_gpkg (str): Output file path for the simplified polygons GeoPackage.
        - layer_name (str): Name of the input layer within the input GeoPackage.
        - tolerance (float): Tolerance value for simplification. Higher values produce simpler geometries.
        """
        subprocess.run([
            "ogr2ogr",
            "-f", "GPKG",
            "-nln", "simplified_layer",
            output_gpkg,
            input_gpkg,
            "-dialect", "sqlite",
            "-sql", f"""
                SELECT
                    ST_SimplifyPreserveTopology(geom, {tolerance}) AS geom,
                    label
                FROM {layer_name}"""
        ], check=True)
        
    def convert_to_geojson(self, input_gpkg, geojson_output):
        """
        Converts the simplified polygons to a GeoJSON file in EPSG:4326 coordinate system.

        Parameters:
        - input_gpkg (str): Input file path to the original polygonized raster GeoPackage.
        - geojson_output (str): Output file path for the GeoJSON file.
        """
        subprocess.run([
            "ogr2ogr",
            "-f", "GeoJSON",
            "-t_srs", "EPSG:4326",
            geojson_output,
            input_gpkg
        ], check=True)
        
    def delete_file(self, path):
        if os.path.exists(path):
            os.remove(path)

    def process(self):
        """Full pipeline: Load image, find colors, classify pixels, determine contours."""
        #original_pixel_size_x = 0.05
        #original_pixel_size_y = 0.05
        if self.downsample_size > 0:
            image = self.downsample_image(self.input_file_path, self.downsample_size)
            #original_pixel_size_x = self.dataset_downsampled.transform[0]
            #original_pixel_size_y = -self.dataset_downsampled.transform[4]
            #scale_factor = self.dataset_downsampled.transform[0] / self.dataset.transform[0]
        else:
            image = self.load_image(self.dataset)
            #original_pixel_size_x = self.dataset.transform[0]
            #original_pixel_size_y = -self.dataset.transform[4]
            #scale_factor = 1

        contour_mask = self.get_largest_contour_mask(image)

        # # Find primary colors inside the contour
        primary_colors = self.determine_clusters(image, contour_mask, num_clusters = self.num_of_clusters)
        
        # # Classify pixels using primary colors
        classified_image = self.determine_closest_color(image, contour_mask, primary_colors)
        
        self.apply_morphological_operators(classified_image, contour_mask, primary_colors)
    
        # Convert the classified image to a label index image
        label_index_image, label_to_color = self.convert_to_label_index_image(classified_image)
    
        # Upsample the label index image
        upsampled_label_index_image = self.upsample_image(label_index_image, self.dataset.height, self.dataset.width)
    
        # Save the classified image
        tmp_dir_path = os.path.dirname(os.path.abspath(self.output_file_path))
        tmp_labeled_image_path = os.path.join(tmp_dir_path, 'labeled_index.tif')
        
        # Save image to original size tiff
        self.save_raster_image(upsampled_label_index_image, tmp_labeled_image_path)
        
        tmp_polygonize_raster_path = os.path.join(tmp_dir_path, 'polygonized_raster.gpkg')
        tmp_layer = "polygonized_layer"
        
        # Polygonize the raster
        self.polygonize_raster(
            tmp_labeled_image_path,
            tmp_polygonize_raster_path,
            tmp_layer
        )
        
        self.delete_file(tmp_labeled_image_path)
        
        tolerance = 0.25
        tmp_simplified_polygonize_raster_path = os.path.join(tmp_dir_path, 'simplified_polygonized_raster.gpkg')
        self.simplify_polygons(tmp_polygonize_raster_path, tmp_simplified_polygonize_raster_path, tmp_layer, tolerance)
        
        self.delete_file(tmp_polygonize_raster_path)
        
        self.convert_to_geojson(tmp_simplified_polygonize_raster_path, self.output_file_path)
        
        ############################## OLD STUFF ##################################
        # contours_dict = self.determine_contours(classified_image, primary_colors)
        
        # filtered_contours_dict = {
        #     color: [cnt for cnt in cnt_list if cv2.contourArea(cnt) > min_contour_size]
        #     for color, cnt_list in contours_dict.items()
        # }

        # #self.display_results(image, classified_image, contour_mask, filtered_contours_dict)
        
        #upsampled_contours_dict = self.apply_upsamling(filtered_contours_dict, scale_factor)
        
        #return self.generate_geojson(upsampled_contours_dict)

        # def generate_geojson(self, contours_dict, output_geojson="output.geojson"):
        #     """
        #     Converts OpenCV contours into a GeoJSON format with correct latitude/longitude coordinates.

        #     Parameters:
        #     - contours_dict (dict): Dictionary where keys are colors, and values are lists of contours.
        #     - output_geojson (str): File path to save the GeoJSON output.

        #     Returns:
        #     - geojson_data (dict): GeoJSON dictionary.
        #     """

        #     # Create a transformer to convert from raster CRS to WGS84
        #     transformer = Transformer.from_crs(self.dataset.crs, "EPSG:4326", always_xy=True)

        #     features = []

        #     for color, contours in contours_dict.items():
        #         for contour in contours:
        #             # Convert pixel coordinates (row, col) to real-world (easting, northing)
        #             real_world_coords = [rasterio.transform.xy(self.dataset.transform, y, x) for x, y in contour.squeeze()]

        #             # Convert real-world (easting, northing) to WGS84 (longitude, latitude)
        #             geo_coords_wgs84 = [transformer.transform(x, y) for x, y in real_world_coords]

        #             if geo_coords_wgs84[0] != geo_coords_wgs84[-1]:
        #                 geo_coords_wgs84.append(geo_coords_wgs84[0])

        #             polygon = Polygon(geo_coords_wgs84)

        #             # Create a valid GeoJSON polygon with color metadata
        #             feature = geojson.Feature(geometry=geojson.Polygon(
        #                                      [list(polygon.exterior.coords)]),
        #                                       properties={"color": str(color)})
                    
        #             features.append(feature)

        #     geojson_data = geojson.FeatureCollection(features)

        #     # Save GeoJSON to a file
        #     with open(self.output_file_path, "w") as f:
        #         geojson.dump(geojson_data, f, indent=2)

        #     #print(f"GeoJSON saved to {output_geojson} in WGS84 format (Lat/Lon)")
        #     return geojson_data

