import L from 'leaflet';
import ReactDOM from 'ReactDOM';
import React from 'React';
import PropTypes from 'prop-types';
import './ProductionMap.scss';
import { _ } from 'webodm/classes/gettext';
import Workers from 'webodm/classes/Workers';

class ProductionMapButton extends React.Component {
    static propTypes = {
        metaUrls: PropTypes.array.isRequired,
        tasks: PropTypes.array.isRequired,
        map: PropTypes.object.isRequired
    }

    constructor(props) {
        super(props);

        this.state = {
            showPanel: false,
            loading: false,
            error: "",
            celery_task_id: null,
            tmpFilename: null,
        };
    }

    handleOpen = async () => { // Changed to async
        console.log('Clicked on tractor button!');
        this.setState({ showPanel: true, loading: true, error: "", celery_task_id: null, tmpFilename: null, });
        console.log('Getching orthophoto export data...');
        await this.fetchOrthophotoExportData();
        console.log('Got orthophoto export data!');

        //TODO change this later
        const { tasks, metaUrls } = this.props;
        const task = tasks[0];

        console.log("ndviPaths 1: ", this.state.tmpFilename);

        const ndviPaths = [this.state.tmpFilename];

        console.log("ndviPaths 2: ", ndviPaths);
        
        if (ndviPaths !== null && ndviPaths.length > 0) {

            this.generateProductionMap(task.id, ndviPaths);
        }
    }

    handleClose = () => {
        this.setState({ showPanel: false, error: "", tmpFilename: null });
    }

    fetchOrthophotoExportData = async () => {
        return new Promise(async (resolve, reject) => {
            const { tasks, metaUrls } = this.props;
            if (tasks.length === 0) {
                this.setState({ error: "No tasks to load", loading: false });
                reject("No tasks to load");
                return;
            }

            if (metaUrls.length === 0) {
                this.setState({ error: "No metaUrls to load" });
                reject("No metaUrls to load");
                return;
            }
            const metaUrl = metaUrls[0];

            try {
                const { minStat, maxStat } = await this.fetchStatistics(metaUrl);

                console.log("Statistic: ", minStat, maxStat);
                const rescale = `${minStat},${maxStat}`; // Use the calculated values
                const apiParams = {
                    formula: "NDVI",
                    bands: "auto",
                    rescale: rescale,
                    format: "gtiff-rgb",
                    color_map: "rdylgn"
                };

                //TODO: add support for where multiple tasks are available?
                const task = tasks[0];
                const { id, project } = task;
                const url = `/api/projects/${project}/tasks/${id}/orthophoto/export`;

                this.loadingReq = $.ajax({
                    url: url,
                    type: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify(apiParams),
                })
                    .done(async res => {
                        console.log('Got data from orthophoto export:', res);
                        if (res.celery_task_id) {
                            this.setState({
                                celery_task_id: res.celery_task_id,
                            });
                            try {
                                Workers.waitForCompletion(res.celery_task_id, async error => {
                                    if (error) {
                                        this.setState({ loading: false, error: error });
                                        reject(error);
                                    } else {
                                        try {
                                            await this.fetchTmpFilename(res.celery_task_id);
                                            resolve();
                                        } catch (error) {
                                            reject(error);
                                        }
                                    }
                                });
                            } catch (error) {
                                reject(error);
                            }
                        } else if (res.error) {
                            this.setState({ error: res.error, loading: false });
                            reject(res.error);
                        }
                    })
                    .fail((err) => {
                        console.error('Error fetching orthophoto export data:', err);
                        this.setState({ error: _("Cannot retrieve information for task. Are you are connected to the internet?"), loading: false });
                        reject(err);
                    })
                    .always(() => {
                        if (!this.state.celery_task_id) {
                            this.setState({ loading: false });
                            this.loadingReq = null;
                            reject("No celery task id");
                        }
                    });
            } catch (error) {
                reject(error);
            }
        });
    }

    fetchStatistics = (metaUrl) => { 
        console.info('Fetching statistics...');
        console.info(metaUrl);

        return new Promise((resolve, reject) => {
            this.JSONLoadingReq = $.getJSON(metaUrl)
                .done(mres => {
                    const { statistics } = mres;
                    let minStat = -1;
                    let maxStat = 1;
                    if (statistics["1"]) {
                        for (let b in statistics) {
                            minStat = Math.min(statistics[b]["percentiles"][0]);
                            maxStat = Math.max(statistics[b]["percentiles"][1]);
                        }
                    }
                    resolve({ minStat, maxStat });
                })
                .fail(err => {
                    console.error('Error fetching orthophoto export data:', err);
                    this.setState({ error: _("Cannot retrieve information for task. Are you are connected to the internet?") });
                    reject(err);
                })
                .always(() => {
                    this.JSONLoadingReq = null;
                });
        });
    }

    fetchTmpFilename = (celery_task_id) => {
        console.log('Fetch filename...');

        return new Promise((resolve, reject) => {
            const getTaskResultUrl = `/api/workers/get/${celery_task_id || this.state.celery_task_id}`;

            this.taskLoadingReq = $.ajax({
                url: getTaskResultUrl,
                type: 'GET',
            })
                .done((data, textStatus, jqXHR) => {
                    const contentDisposition = jqXHR.getResponseHeader('Content-Disposition');
                    let filename = '';
                    if (contentDisposition && contentDisposition.indexOf('filename=') !== -1) {
                        filename = contentDisposition.split('filename=')[1];
                        filename = filename.replace(/['"]/g, '');
                    }

                    console.log('Tmp filename: ', filename);

                    this.setState({ tmpFilename: filename }, () => {
                        resolve(filename); // Resolve the promise with the filename
                    });
                })
                .fail((err) => {
                    console.error('Error getting download filename:', err);
                    this.setState({ error: _("Cannot retriev content disposition information from task."), tmpFilename: '' });
                    reject(err); // Reject the promise on error
                })
                .always(() => {
                    this.setState({ loading: false });
                    this.taskLoadingReq = null;
                });
        });
    }

    generateProductionMap = (taskId, data) => {
        console.log('Generating production map...');
        this.generateProdMapReq = $.ajax({
            type: 'POST',
            url: `/api/plugins/production_map/task/${taskId}/production_map/generate`,
            data: JSON.stringify({ ndvi_paths: data }),
            contentType: 'application/json', 
        }).done(result => {
            if (result.celery_task_id){
                Workers.waitForCompletion(result.celery_task_id, error => {
                if (error) this.setState({ error: "No production map to load", loading: false });
                else{
                    console.log('Production map generated!');

                    const fileUrl = `/api/plugins/production_map/task/${taskId}/production_map/download/${result.celery_task_id}`;

                    this.addGeoJSONFromURL(fileUrl, e => {
                        if (e) this.setState({error: JSON.stringify(e)});
                        this.setState();
                    });
                }
                });
            }else if (result.error){
                this.setState({loading: false , error: result.error});
            }else{
                this.setState({loading: false , error: "Invalid response: " + result});
            }
        }).fail(error => {
            this.setState({loading: false , error: JSON.stringify(error)});
        });
    }

    addGeoJSONFromURL = (url, cb) => {
    const { map } = this.props;

    $.getJSON(url)
        .done((geojson) => {
        try{
        //this.handleRemovePreview();
        console.log("Inside getJSON...")
        this.setState({previewLayer: L.geoJSON(geojson, {
            onEachFeature: (feature, layer) => {
                //TODO: add descriptions based on different zones
                // if (feature.properties && feature.properties.level !== undefined) {
                //     layer.bindPopup(`<div style="margin-right: 32px;"><b>${_("Elevation:")}</b> ${us.elevation(feature.properties.level)}</div>`);
                // }
            },
            style: feature => {
                return {color: "lightblue", opacity: 0.7};
            }
        })});
        this.state.previewLayer.addTo(map);

        cb();
        } catch(e) {
            cb(e.message);
        }

        })
        .fail(cb);
    }

    componentWillUnmount() {
        if (this.JSONLoadingReq) {
            this.JSONLoadingReq.abort();
            this.JSONLoadingReq = null;
        }

        if (this.loadingReq) {
            this.loadingReq.abort();
            this.loadingReq = null;
        }
        if (this.taskLoadingReq) {
            this.taskLoadingReq.abort();
            this.taskLoadingReq = null;
        }
        if (this.generateProdMapReq) {
            this.generateProdMapReq.abort();
            this.generateProdMapReq = null;
        }
    }

    render() {
        const { showPanel, loading, error } = this.state;
        return (
            <div>
                <a href="javascript:void(0);" title="Get production data" className="js-my-custom-button" onClick={this.handleOpen}>
                    <i className="fa fa-tractor" aria-hidden="true"></i>
                </a>
                {/* {loading && <div className="alert alert-info">{_("Loading...")} <i className="fa fa-spin fa-circle-notch" /></div>}
                {error && <div className="alert alert-danger">{error}</div>} */}
            </div>

        );
    }
}

export default L.Control.extend({
    options: {
        position: 'topright'
    },

    onAdd: function (map) {
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom"');
        L.DomEvent.disableClickPropagation(container);
        ReactDOM.render(<ProductionMapButton map={this.options.map} tasks={this.options.tasks} metaUrls={this.options.metaUrls} />, container);

        return container;
    }
});
