from rest_framework import status
from rest_framework.response import Response
from app.plugins.views import TaskView, CheckTask, GetTaskResult
from app.plugins.worker import run_function_async
from django.utils.translation import gettext_lazy as _

import logging


class ProductionMapException(Exception):
    pass

def calc_production_map():
    return {'file': 'production_map.tif'}

class TaskProductionMapGenerate(TaskView):
    def post(self, request, pk=None):
        #task = self.get_and_check_task(request, pk)
        logger = logging.getLogger('app.logger')  
        try:
            celery_task_id = run_function_async(calc_production_map).task_id
            logger.info(f"TaskProductionMapGenerate: {celery_task_id}")
            return Response({'celery_task_id': celery_task_id}, status=status.HTTP_200_OK)
        except ProductionMapException as e:
            logger.info(f"Exception!!!!!!!!")
            return Response({'error': str(e)}, status=status.HTTP_200_OK)


class TaskProductionMapDownload(GetTaskResult): # Use GetTaskResult
    pass