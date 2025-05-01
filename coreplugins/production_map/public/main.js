PluginsAPI.Map.willAddControls([
    'production_map/build/ProductionMap.js',
    'production_map/build/ProductionMap.css',
    'production_map/build/ProductionMapPanel.js',
    'production_map/build/ProductionMapPanel.css'
], function(args, ProductionMap){
var tasks = [];
var metaUrls = [];
var ids = {};


hasBands = (bands, orthophoto_bands) => {
    if (!orthophoto_bands) return false;

    for (let i = 0; i < bands.length; i++){
      if (orthophoto_bands.find(b => b.description !== null && b.description.toLowerCase() === bands[i].toLowerCase()) === undefined) return false;
    }
    
    return true;
  }


for (var i = 0; i < args.tiles.length; i++){

    //console.log('Task: ', args.tiles[i].meta.task);

    if(args.tiles[i].meta.task && hasBands(["red", "green", "nir"], args.tiles[i].meta.task.orthophoto_bands)) {
        
        var task = args.tiles[i].meta.task;
        
        const { url } = args.tiles[i];
        let metaUrl = url + "metadata";
        metaUrl += `?formula=NDVI&bands=auto&color_map=rdylgn`;

        if (!ids[task.id]){ 
            console.log('Task ID: ', task.id);
            console.log('Meta url: ', metaUrl);
            tasks.push(task);
            metaUrls.push(metaUrl);
            ids[task.id] = true;
        }
    }
}

args.map.addControl(new ProductionMap({map: args.map, tasks: tasks, metaUrls: metaUrls}));

});