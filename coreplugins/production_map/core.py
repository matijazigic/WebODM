import rasterio
import numpy as np
import cv2
import os
from pyproj import Transformer
from shapely import Polygon
import geojson

import logging

logger = logging.getLogger('app.logger')

class ProductionMapGenerator:
    def __init__(self, input_file_paths, output_file_path):
        self.input_file_paths = input_file_paths
        self.output_file_path = output_file_path
        
        try:
            self.dataset = rasterio.open(input_file_paths[0])
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
    
    def downsample_image(self, path, downsample_resolution = 5):
        import subprocess

        output_name = os.path.splitext(os.path.basename(path))[0] + "_downsampled.tif"
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
            print(f"Error opening file: {e}")
            raise
        
        return self.load_image(self.dataset_downsampled)
        
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

        # **Prepare data for OpenCV kmeans**
        data = inside_pixels_lab.astype(np.float32)

        # **Apply OpenCV K-Means Clustering**
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.2)
        _, labels, centers = cv2.kmeans(data, num_clusters, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)

        # **Extract k dominant colors**
        primary_colors_lab = centers.astype(np.uint8)
        primary_colors_rgb = cv2.cvtColor(primary_colors_lab.reshape(1, -1, 3), cv2.COLOR_LAB2RGB).reshape(-1, 3)

        return primary_colors_rgb
    
    def determine_contours(self, image, primary_colors, color_threshold = 30):
        """
        Calculates contours based on primary color masks and displays contours over the mask.

        Parameters:
        - image: Input RGB image.
        - contour_mask: Binary mask for the region of interest.
        - primary_colors: List of RGB cluster colors.
        - color_threshold: Threshold for color similarity in LAB space.

        Returns:
        - contours_dict: Dictionary with primary colors as keys and lists of contours as values.
        """
        lab_image = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
        contours_dict = {}
        primary_color_masks = np.zeros((image.shape[0], image.shape[1], len(primary_colors)), dtype=np.uint8)

        for i, color in enumerate(primary_colors):
            color_lab = cv2.cvtColor(np.uint8([[color]]), cv2.COLOR_RGB2LAB)[0][0]
            diff = np.linalg.norm(lab_image.astype(np.int16) - color_lab.astype(np.int16), axis=2)
            primary_color_masks[:, :, i] = (diff < color_threshold).astype(np.uint8) * 255
            
            #TODO: check how to implement - trying to remove gap between contours
            # if i == 0:
            #     kernel = np.ones((3, 3), np.uint8)
            #     primary_color_masks[:, :, i] = cv2.dilate(primary_color_masks[:, :, i], kernel, iterations=1)

        for i, color in enumerate(primary_colors):
            contours, hierarchy = cv2.findContours(primary_color_masks[:, :, i], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            contours_dict[tuple(color)] = contours
            mask_with_contours = cv2.cvtColor(primary_color_masks[:, :, i], cv2.COLOR_GRAY2BGR) 
            cv2.drawContours(mask_with_contours, contours, -1, (255, 255, 0), thickness=1)

        return contours_dict
            
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

    def process(self, downsample_size = 1, color_cluster_num = 2, min_contour_size = 10):
        """Full pipeline: Load image, find colors, classify pixels, determine contours."""
        original_pixel_size_x = 0.05
        original_pixel_size_y = 0.05
        if downsample_size > 0:
            image = self.downsample_image(self.input_file_paths[0], downsample_size)
            original_pixel_size_x = self.dataset_downsampled.transform[0]
            original_pixel_size_y = -self.dataset_downsampled.transform[4]
            scale_factor = self.dataset_downsampled.transform[0] / self.dataset.transform[0]
        else:
            image = self.load_image(self.dataset)
            original_pixel_size_x = self.dataset.transform[0]
            original_pixel_size_y = -self.dataset.transform[4]
            scale_factor = 1

        contour_mask = self.get_largest_contour_mask(image)

        # # Find primary colors inside the contour
        primary_colors = self.determine_clusters(image, contour_mask, num_clusters = color_cluster_num)
        
        # # Classify pixels using primary colors
        classified_image = self.determine_closest_color(image, contour_mask, primary_colors)
        
        self.apply_morphological_operators(classified_image, contour_mask, primary_colors)
    
        contours_dict = self.determine_contours(classified_image, primary_colors)
        
        filtered_contours_dict = {
            color: [cnt for cnt in cnt_list if cv2.contourArea(cnt) > min_contour_size]
            for color, cnt_list in contours_dict.items()
        }

        # #self.display_results(image, classified_image, contour_mask, filtered_contours_dict)
        
        upsampled_contours_dict = self.apply_upsamling(filtered_contours_dict, scale_factor)
        
        self.generate_geojson(upsampled_contours_dict)

    def generate_geojson(self, contours_dict, output_geojson="output.geojson"):
        """
        Converts OpenCV contours into a GeoJSON format with correct latitude/longitude coordinates.

        Parameters:
        - contours_dict (dict): Dictionary where keys are colors, and values are lists of contours.
        - output_geojson (str): File path to save the GeoJSON output.

        Returns:
        - geojson_data (dict): GeoJSON dictionary.
        """

        # Create a transformer to convert from raster CRS to WGS84
        transformer = Transformer.from_crs(self.dataset.crs, "EPSG:4326", always_xy=True)

        features = []

        for color, contours in contours_dict.items():
            for contour in contours:
                # Convert pixel coordinates (row, col) to real-world (easting, northing)
                real_world_coords = [rasterio.transform.xy(self.dataset.transform, y, x) for x, y in contour.squeeze()]

                # Convert real-world (easting, northing) to WGS84 (longitude, latitude)
                geo_coords_wgs84 = [transformer.transform(x, y) for x, y in real_world_coords]

                if geo_coords_wgs84[0] != geo_coords_wgs84[-1]:
                    geo_coords_wgs84.append(geo_coords_wgs84[0])

                polygon = Polygon(geo_coords_wgs84)

                # Create a valid GeoJSON polygon with color metadata
                feature = geojson.Feature(geometry=geojson.Polygon(
                                         [list(polygon.exterior.coords)]),
                                          properties={"color": str(color)})
                
                features.append(feature)

        geojson_data = geojson.FeatureCollection(features)

        # Save GeoJSON to a file
        with open(self.output_file_path, "w") as f:
            geojson.dump(geojson_data, f, indent=2)

        #print(f"GeoJSON saved to {output_geojson} in WGS84 format (Lat/Lon)")
        return geojson_data

