from app.plugins import PluginBase
from app.plugins import MountPoint
from .api import TaskProductionMapGenerate, TaskProductionMapDownload # Import both classes



class Plugin(PluginBase):

    # def main_menu(self):
    #     return [Menu("Test", self.public_url("menu_url/"), "test-icon")]

    def include_js_files(self):
        return ['main.js']

    # def include_css_files(self):
    #     return ['ProductionMap.scss']

    def build_jsx_components(self):
        return ['ProductionMap.jsx']
    
    # def build_ts_components(self):
    #     return ['index.ts']

    def api_mount_points(self):        
        return [
            MountPoint('task/(?P<pk>[^/.]+)/production-map/generate', TaskProductionMapGenerate.as_view()),
            MountPoint('task/[^/.]+/production-map/download/(?P<celery_task_id>.+)', TaskProductionMapDownload.as_view()),
        ]
