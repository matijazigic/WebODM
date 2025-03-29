import React from 'react';
import PropTypes from 'prop-types';
import Storage from 'webodm/classes/Storage';
import L from 'leaflet';
import './ProductionMapPanel.scss';
import ErrorMessage from 'webodm/components/ErrorMessage';
import Workers from 'webodm/classes/Workers';
import { _ } from 'webodm/classes/gettext';
//import { systems, getUnitSystem, onUnitSystemChanged, offUnitSystemChanged, toMetric } from 'webodm/classes/Units';

export default class ProductionMapPanel extends React.Component {
    static defaultProps = {
    };
    static propTypes = {
        onClose: PropTypes.func.isRequired,
        metaUrls: PropTypes.array.isRequired,
        tasks: PropTypes.array.isRequired,
        map: PropTypes.object.isRequired,
        isShowed: PropTypes.bool.isRequired
    }

    constructor(props) {
        super(props);

        // const unitSystem = getUnitSystem();
        // const defaultInterval = unitSystem === "metric" ? "1" : "4";
        // const defaultSimplify = unitSystem === "metric" ? "0.2" : "0.6";

        // Remove legacy parameters
        // Storage.removeItem("last_contours_interval");
        // Storage.removeItem("last_contours_custom_interval");
        // Storage.removeItem("last_contours_simplify");
        // Storage.removeItem("last_contours_custom_simplify");

        this.state = {
            step: 0,
            step_dict: { 0: 'Initialization', 1: 'Fetching statistics', 2: 'Loading NDVI', 3: 'Getting NDVI', 4: 'Got NDVI', 5: 'Generate production map', 6: 'Getting GeoJSON', 7: 'Got GeoJSON' },
            error: "",
            permanentError: "",
            // interval: Storage.getItem("last_contours_interval_" + unitSystem) || defaultInterval,
            // customInterval: Storage.getItem("last_contours_custom_interval_" + unitSystem) || defaultInterval,
            // simplify: Storage.getItem("last_contours_simplify_" + unitSystem) || defaultSimplify,
            // customSimplify: Storage.getItem("last_contours_custom_simplify_" + unitSystem) || defaultSimplify,
            //layer: "",
            // epsg: Storage.getItem("last_contours_epsg") || "4326",
            // customEpsg: Storage.getItem("last_contours_custom_epsg") || "4326",
            //layers: [],
            task: props.tasks[0] || null,
            ndvi_paths: [],
            productionMapLayer: null,
            downsampleSize: 1,
            zoneCount: 2,
            //unitSystem
        };
    }

    componentDidMount() {
        //onUnitSystemChanged(this.unitsChanged);
    }

    componentDidUpdate() {
        if (this.props.isShowed && this.state.step == 0) {
            const { tasks, metaUrls } = this.props;
            if (tasks.length === 0) {
                this.setState({ permanentError: "No tasks to load!" });
                return;
            }

            if (metaUrls.length === 0) {
                this.setState({ permanentError: "No metaUrls to load!" });
                return;
            }

            const { id, project } = tasks[0];
            const metaUrl = metaUrls[0];

            console.log("generateNDVI")
            this.generateNDVI(project, id, metaUrl);

            //  const {id, project} = this.state.task;

            //   this.loadingReq = $.getJSON(`/api/projects/${project}/tasks/${id}/`)
            //       .done(res => {
            //           const { available_assets } = res;
            //           let layers = [];

            //           if (available_assets.indexOf("dsm.tif") !== -1) layers.push("DSM");
            //           if (available_assets.indexOf("dtm.tif") !== -1) layers.push("DTM");

            //           if (layers.length > 0){
            //             this.setState({layers, layer: layers[0]});
            //         }else{
            //             this.setState({permanentError: _("No DSM or DTM is available. To export contours, make sure to process a task with either the --dsm or --dtm option checked.")});
            //           }
            //       })
            //       .fail(() => {
            //         this.setState({permanentError: _("Cannot retrieve information for task. Are you are connected to the internet?")})
            //       })
            //       .always(() => {
            //         this.setState({loading: false});
            //         this.loadingReq = null;
            //       });
            // }
        }
    }

    componentWillUnmount() {
        if (this.taskLoadStatistics) {
            this.taskLoadStatistics.abort();
            this.taskLoadStatistics = null;
        }
        if (this.taskLoadingRequest) {
            this.taskLoadingRequest.abort();
            this.taskLoadingRequest = null;
        }
        if (this.taskFetchTmpFile) {
            this.taskFetchTmpFile.abort();
            this.taskFetchTmpFile = null;
        }
        if (this.taskGenerateProdMapReq) {
            this.taskGenerateProdMapReq.abort();
            this.taskGenerateProdMapReq = null;
        }
        if (this.taskAddGeoJSONFromURL) {
            this.taskAddGeoJSONFromURL.abort();
            this.taskAddGeoJSONFromURL = null;
        }

        //offUnitSystemChanged(this.unitsChanged);
    }

    generateNDVI = (project, taskId, metaUrl) => {
        this.setState({ step: 1 });

        console.info('Fetching statistics...');
        console.info(metaUrl);

        return new Promise((resolve, reject) => {
            this.taskLoadStatistics = $.getJSON(metaUrl)
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

                    const rescale = `${minStat},${maxStat}`; // Use the calculated values
                    const apiParams = {
                        formula: "NDVI",
                        bands: "auto",
                        rescale: rescale,
                        format: "gtiff-rgb",
                        color_map: "rdylgn"
                    };

                    this.fetchOrthophotoExportData(project, taskId, apiParams);
                    resolve();
                })
                .fail(err => {
                    this.setState({ error: _("Cannot retrieve information for task. Are you are connected to the internet?"), step: 0 });
                    reject(err);
                })
                .always(() => {
                    this.taskLoadStatistics = null;
                });
        });
    }

    fetchOrthophotoExportData = (project, taskid, params) => {
        this.setState({ step: 2 });

        return new Promise((resolve, reject) => {
            try {
                console.log('Fetch ortophoto data...');
                const url = `/api/projects/${project}/tasks/${taskid}/orthophoto/export`;

                this.taskLoadingRequest = $.ajax({
                    url: url,
                    type: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify(params),
                })
                    .done(res => {
                        console.log('Got data from orthophoto export:', res);
                        if (res.celery_task_id) {
                            try {
                                Workers.waitForCompletion(res.celery_task_id, error => {
                                    if (error) {
                                        console.log('Error:', error);
                                        this.setState({ error: error });
                                        reject(error);
                                    } else {
                                        console.log('celeryTaskId:', res.celery_task_id);
                                        this.fetchOrthophotoTmpFilename(res.celery_task_id);
                                        resolve();
                                    }
                                });
                            } catch (error) {
                                reject(error);
                            }
                        } else if (res.error) {
                            this.setState({ error: res.error });
                            reject(res.error);
                        }
                    })
                    .fail((err) => {
                        this.setState({ error: _("Cannot retrieve information for task. Are you are connected to the internet?") });
                        reject(err);
                    })
                    .always(() => {
                        this.taskLoadingRequest = null;
                    });
            } catch (error) {
                reject(error);
            }
        });
    }

    fetchOrthophotoTmpFilename = (celery_task_id) => {
        this.setState({ step: 3 });
        console.log('Fetch filename...');

        return new Promise((resolve, reject) => {
            const getTaskResultUrl = `/api/workers/get/${celery_task_id}`;

            this.taskFetchTmpFile = $.ajax({
                url: getTaskResultUrl,
                type: 'GET',
            })
                .done((data, textStatus, jqXHR) => {
                    const contentDisposition = jqXHR.getResponseHeader('Content-Disposition');

                    console.log('contentDisposition: ', contentDisposition);

                    let filename = '';
                    if (contentDisposition && contentDisposition.indexOf('filename=') !== -1) {
                        filename = contentDisposition.split('filename=')[1];
                        filename = filename.replace(/['"]/g, '');
                    }

                    console.log('Tmp filename: ', filename);
                    this.setState({ ndvi_paths: [filename], step: 4 });
                    resolve();
                })
                .fail((err) => {
                    this.setState({ error: _("Cannot retrieve content disposition information from task."), step: 0 });
                    reject(err);
                })
                .always(() => {
                    console.log('Done fetching filename');
                    this.taskFetchTmpFile = null;
                });
        });
    }

    generateProductionMap = (taskId, ndvi_paths, num_of_zones, downsample_size) => {
        const payload = {
            ndvi_paths: ndvi_paths,
            num_of_zones: num_of_zones,
            downsample_size: downsample_size
        };

        console.log("Payload:", payload);

        this.taskGenerateProdMapReq = $.ajax({
            type: 'POST',
            url: `/api/plugins/production_map/task/${taskId}/production_map/generate`,
            data: JSON.stringify(payload),
            contentType: 'application/json',
        }).done(result => {
            if (result.celery_task_id) {
                Workers.waitForCompletion(result.celery_task_id, error => {
                    if (error) this.setState({ error: "No production map to load!", step: 0 });
                    else {
                        const fileUrl = `/api/plugins/production_map/task/${taskId}/production_map/download/${result.celery_task_id}`;
                        this.addGeoJSONFromURL(fileUrl, e => {
                            if (e) this.setState({ error: JSON.stringify(e), step: 0 });
                            this.setState();
                        });
                    }
                });
            } else if (result.error) {
                this.setState({ error: result.error, step: 0 });
            } else {
                this.setState({ error: "Invalid response: " + result, step: 0 });
            }
        }).fail(error => {
            this.setState({ error: JSON.stringify(error), step: 0 });
        }).always(() => {
            console.log('Done fetching filename');
            this.taskGenerateProdMapReq = null;
        });
    }

    addGeoJSONFromURL = (url, cb) => {
        this.setState({ step: 6 });

        const { map } = this.props;

        //COLORS
        const leafletColors = [
            "red", "blue", "green", "orange", "purple", "darkred", "darkblue", "darkgreen", "darkorange", "darkpurple"
        ];

        const labelColorCache = {};
        const getColorForLabel = (label) => {
            if (!labelColorCache[label]) {
                // Generate a random index between 0 and leafletColors.length - 1
                const colorIndex = Math.floor(Math.random() * leafletColors.length);

                // Cache the color for the label
                labelColorCache[label] = leafletColors[colorIndex];
            }
            return labelColorCache[label];
        };

        this.taskAddGeoJSONFromURL = $.getJSON(url)
            .done((geojson) => {
                try {
                    this.handleRemoveProductionLayer();

                    this.setState({ step: 7 });

                    this.setState({
                        productionMapLayer: L.geoJSON(geojson, {
                            onEachFeature: (feature, layer) => {
                                if (feature.properties && feature.properties !== undefined) {
                                    const { label } = feature.properties
                                    layer.bindPopup(`
                                        <div style="margin-right: 32px;">
                                        <b>${_("Description:")}</b><br>
                                        <b>Label: </b> ${label}
                                        </div>
                                    `);
                                }
                            },
                            style: (feature) => {
                                const { label } = feature.properties;

                                const color = getColorForLabel(label);

                                return {
                                    color: color,
                                    fillColor: color,
                                    fillOpacity: 0.4,
                                    weight: 2,
                                };
                            },
                        })
                        , step: 7
                    });
                    this.state.productionMapLayer.addTo(map);

                    cb();
                } catch (e) {
                    cb(e.message);
                }
            })
            .fail(cb);
    }

    handleRemoveProductionLayer = () => {
        const { map } = this.props;
        if (this.state.productionMapLayer) {
            map.removeLayer(this.state.productionMapLayer);
            this.setState({ productionMapLayer: null });
        }
    }

    handleZoneCountChange = (event) => {
        const zoneCount = parseInt(event.target.value, 10); // Convert the value to an integer
        if (!isNaN(zoneCount)) {
            console.log("Not nan: ", zoneCount)
        } else {
            console.error("Invalid zoneCount value:", event.target.value);
        }
        console.log("zoneCount: ", zoneCount)
        this.setState({ zoneCount });
    };

    handleDownsampleChange = (event) => {
        const downsampleValue = parseFloat(event.target.value);
        if (!isNaN(downsampleValue) && downsampleValue >= 0) {
            this.setState({ downsampleSize: downsampleValue });
        } else {
            this.setState({ downsampleSize: 1.0 });
        }
    };

    // handleExport = (format) => {
    //     return () => {
    //         //const data = this.getFormValues(false);
    //         data.format = format;
    //         this.generateContours(data, 'exportLoading', false);
    //     };
    // }

    handleGenerateProductionMap = () => {
        this.setState({ step: 5 });
        this.generateProductionMap(this.state.task.id, this.state.ndvi_paths, this.state.zoneCount, this.state.downsampleSize);
    }

    render() {
        const {
            step,
            step_dict,
            permanentError,
            productionMapLayer,
            downsampleSize,
            zoneCount
            // interval, customInterval, layer, 
            // epsg, customEpsg, 
            // simplify, customSimplify,
            //unitSystem 
        } = this.state;

        let content = "";

        if (step < 4) content =
            (
                <span>
                    <i className="fa fa-circle-notch fa-spin"></i>{" "}
                    {step_dict[step] ? step_dict[step] : _("Loading…")}
                </span>
            );
        else if (permanentError) content = (<div className="alert alert-warning">{permanentError}</div>);
        else {
            content = (
                <div>
                    <ErrorMessage bind={[this, "error"]} />

                    <div className="row mb-3 justify-content-end">
                        <div className="col-sm-6">
                            <label htmlFor="floatValue" className="form-label">{_("Downsampling:")}</label>
                        </div>
                        <div className="col-sm-6">
                            <input
                                id="floatValue"
                                type="number"
                                step="0.1"
                                className="form-control"
                                value={downsampleSize}
                                onChange={this.handleDownsampleChange}
                                disabled={step < 4 || (step >= 5 && step < 7)}
                            />
                        </div>
                    </div>

                    <div className="row mb-3 justify-content-end">
                        <div className="col-sm-6">
                            <label htmlFor="zoneCount" className="form-label">{_("Num of zones:")}</label>
                        </div>
                        <div className="col-sm-6">
                            <select
                                id="zoneCount"
                                className="form-control"
                                value={zoneCount}
                                onChange={this.handleZoneCountChange}
                                disabled={step < 4 || (step >= 5 && step < 7)}
                            >
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                                <option value={4}>4</option>
                                <option value={5}>5</option>
                            </select>
                        </div>
                    </div>

                    <div className="row action-buttons justify-content-end">
                        <div className="col-sm-12 text-right">
                            <button
                                title='Generate production map zones'
                                onClick={this.handleGenerateProductionMap}
                                disabled={step < 4 || (step >= 5 && step < 7)}
                                type="button"
                                className="btn btn-sm btn-primary btn-preview mr-2"
                            >
                                {step == 5 ? (
                                    <i className="fa fa-spin fa-circle-notch" />
                                ) : (
                                    <i className="fa fa-leaf" />
                                )}{" "}
                                {_("Generate")}
                            </button>

                            <button
                                title='Export to ISOXML'
                                onClick={this.handleExport}
                                disabled={step < 7} //TODO: disable when generating...
                                type="button"
                                className="btn btn-sm btn-primary btn-preview mr-2"
                            >
                                {step == 9 ? (
                                    <i className="fa fa-spin fa-circle-notch" />
                                ) : (
                                    <i className="fa fa-layer-group" />
                                )}{" "}
                                {_("Export")}
                            </button>

                            {/* Remove Production Map Button */}
                            {productionMapLayer && (
                                <button
                                    title="Remove production map"
                                    onClick={this.handleRemoveProductionLayer}
                                    type="button"
                                    className="btn btn-sm btn-danger btn-preview mr-2"
                                >
                                    <i className="fa fa-trash" /> {_("Remove")}
                                </button>
                            )}
                        </div>
                    </div>

                </div>
            );
        }

        return (<div className="production-map-panel">
            <span className="close-button" onClick={this.props.onClose} />
            <div className="title">{_("Production Map")}</div>
            <hr />
            {content}
        </div>);
    }
}
