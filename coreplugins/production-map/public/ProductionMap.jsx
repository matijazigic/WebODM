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
        console.log('fetchOrthophotoExportData...');
        this.fetchOrthophotoExportData();

        //TODO change this later
        const { tasks, metaUrls } = this.props;
        const task = tasks[0];

        this.generateProductionMap(task.id);
    }

    handleClose = () => {
        this.setState({ showPanel: false, error: "", tmpFilename: null });
    }

    fetchOrthophotoExportData = async () => { // Changed to async
        const { tasks, metaUrls } = this.props;
        if (tasks.length === 0) {
            this.setState({ error: "No tasks to load", loading: false });
            return;
        }

        if (metaUrls.length === 0) {
            this.setState({ error: "No metaUrls to load" });
            return;
        }
        const metaUrl = metaUrls[0];

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
            .done(res => {
                console.log('Got data from /orthophoto/export:', res);
                if (res.celery_task_id) {
                    this.setState({
                        celery_task_id: res.celery_task_id,
                    });
                    Workers.waitForCompletion(res.celery_task_id, error => {
                        if (error) {
                            this.setState({ loading: false, error: error });
                        } else {
                            this.fetchTmpFilename(res.celery_task_id);
                        }
                    });
                } else if (res.error) {
                    this.setState({ error: res.error, loading: false });
                }
            })
            .fail((err) => {
                console.error('Error fetching orthophoto export data:', err);
                this.setState({ error: _("Cannot retrieve information for task. Are you are connected to the internet?"), loading: false });
            })
            .always(() => {
                if (!this.state.celery_task_id) {
                    this.setState({ loading: false });
                    this.loadingReq = null;
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

    fetchTmpFilename = (fileUrl, celery_task_id) => {
        console.log('Fetch filename...');

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

                this.setState({ tmpFilename: filename });
            })
            .fail((err) => {
                console.error('Error getting download filename:', err);
                this.setState({ error: _("Cannot retriev content disposition information from task."), tmpFilename: '' });
            })
            .always(() => {
                this.setState({ loading: false });
                this.taskLoadingReq = null;
            });
    }

    generateProductionMap = (taskId) => {
        console.log('Generating production map...', taskId);
        this.generateProdMapReq = $.ajax({
            type: 'POST',
            url: `/api/plugins/production-map/task/${taskId}/production-map/generate`
            //data: data
        }).done(result => {
            if (result.celery_task_id){
                Workers.waitForCompletion(result.celery_task_id, error => {
                if (error) this.setState({ error: "No production map to load", loading: false });
                else{
                    console.log('Production map generated!');
                    // const fileUrl = `/api/plugins/contours/task/${taskId}/contours/download/${result.celery_task_id}`;

                    // // Preview
                    // if (isPreview){
                    // this.addGeoJSONFromURL(fileUrl, e => {
                    //     if (e) this.setState({error: JSON.stringify(e)});
                    //     this.setState({[loadingProp]: false});
                    // });
                    // }else{
                    // // Download
                    // location.href = fileUrl;
                    // this.setState({[loadingProp]: false});
                    // }
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
