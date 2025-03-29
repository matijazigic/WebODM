from rest_framework import serializers
from rest_framework import status
from rest_framework.response import Response
from app.api.workers import GetTaskResult, TaskResultOutputError
from app.models import Task
from app.plugins.views import TaskView
from django.utils.translation import gettext_lazy as _
from app.plugins.worker import run_function_async


class ProductionMapException(Exception):
    pass

#WORKER
def calc_production_map(ndvi_image_paths, task_id, downsample_size, num_of_zones):
    from app.plugins.functions import get_plugin_by_name  
    from webodm import settings
    import logging
    import os
    
    logger = logging.getLogger('app.logger')
    
    ndvi_image_paths = [
    os.path.join(settings.MEDIA_TMP, path) for path in ndvi_image_paths
    ]
    
    production_map_dir = os.path.join(settings.MEDIA_TMP, 'production_map')
    if not os.path.exists(production_map_dir):
        os.makedirs(production_map_dir)
    
    filename = f"production_map_{task_id}.geojson"
    output_path = os.path.join(production_map_dir, filename)
    
    pm_plugin = get_plugin_by_name('production_map')
    with pm_plugin.python_imports():
        try:
            # Import from coreplugins if using Docker
            from coreplugins.production_map.core import (
                ProductionMapGenerator
            )
            
        except ImportError:
            pass
            # Import from plugins if imported as a plugin on exe application
            from plugins.production_map.core import (
                ProductionMapGenerator
                )
        
        try:
            logger.info(f"Processing ... {ndvi_image_paths[0]}")
            with ProductionMapGenerator(ndvi_image_paths, downsample_size, num_of_zones, output_path) as generator:
                generator.process()
            logger.info(f"End...")
        
        except Exception as e:
            logger.info(f"An error occurred: {e}")
    
    # TODo what if doesn't exist
    logger.info(f"Returning with file path {output_path}")
    return {'file': output_path}


class TaskProductionMapGenerate(TaskView):
    
    def post(self, request, pk=None):
        task = self.get_and_check_task(request, pk)
        ndvi_paths = request.data.get('ndvi_paths')
        downsample_size = request.data.get('downsample_size')
        num_of_zones = request.data.get('num_of_zones')
        
        try:
            celery_task_id = run_function_async(calc_production_map, ndvi_paths, task.id, downsample_size, num_of_zones).task_id
            return Response({'celery_task_id': celery_task_id}, status=status.HTTP_200_OK)
        except ProductionMapException as e:
            return Response({'error': str(e)}, status=status.HTTP_200_OK)


class TaskProductionMapDownload(GetTaskResult): # Use GetTaskResult
    pass