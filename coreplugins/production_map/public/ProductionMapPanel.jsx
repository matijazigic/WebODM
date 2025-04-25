import React from 'react';
import PropTypes from 'prop-types';
import Storage from 'webodm/classes/Storage';
import L, { geoJson } from 'leaflet';
import './ProductionMapPanel.scss';
import ErrorMessage from 'webodm/components/ErrorMessage';
import Workers from 'webodm/classes/Workers';
import { _ } from 'webodm/classes/gettext';

import { ISOXMLManager, TAGS, TaskTaskStatusEnum, LineStringLineStringTypeEnum, ProductGroupProductGroupTypeEnum, PolygonPolygonTypeEnum } from "isoxml";
import { createGridParamsGenerator } from "isoxml/dist/entities/Grid/DefaultGridParamsGenerator";
import * as turf from "@turf/turf";

class ISOXMLGenerator {
    constructor(options) {
        this.options = options;
        const gridParamsGenerator = createGridParamsGenerator(1, 1);
        const managerOptions = {
            fmisTitle: "Open Drone Map Production Map Plugin",
            fmisVersion: "0.0.0.1",
            version: 3,
            gridParamsGenerator,
        };
        this.isoxmlManager = new ISOXMLManager(managerOptions);
    }

    saveFile(data, filename) {
        const blob = new Blob([data], { type: 'application/zip' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    saveGeoJSONToFile = (geoJson, filename = "geojson_production_map.json") => {
        // Convert the geoJSON object to a JSON string
        const jsonString = JSON.stringify(geoJson, null, 2);

        // Create a Blob with the JSON string
        const blob = new Blob([jsonString], { type: "application/json" });

        // Create a temporary <a> element
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;

        // Append the link to the document, trigger the download, and remove it
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    async generate(outputPath = "isoxml.zip") {
        const geoJson = this.options.geoJson;

        if (!geoJson || !geoJson.features || geoJson.features.length === 0) {
            throw new Error("No features found in the GeoJSON.");
        }

        geoJson.features.forEach(feature => {
            const label = feature.properties.label;

            let raw_value = this.options.zoneValues[label - 1] * ConversionFactorDictionary[this.options.valuePresentation.UnitDesignator];
            raw_value = raw_value / ResolutionDictionary[this.options.valuePresentation.UnitDesignator];

            console.log("Label, raw_value ", label, raw_value);

            if (label && this.options.zoneValues[label - 1] !== undefined) {
                feature.properties.DOSE = raw_value;
            } else {
                feature.properties.DOSE = 0;
            }
        });

        this.saveGeoJSONToFile(geoJson)

        const flattened = turf.flatten(geoJson);
        const points = [];
        for (const feature of flattened.features) {
            turf.coordAll(feature).forEach((coord) => points.push(turf.point(coord)));
        }
        const hull = turf.convex(turf.featureCollection(points));
        if (!hull)
            throw new Error("Convex hull could not be created.");
        const buffered = turf.buffer(hull, this.options.bufferSize, {
            units: "meters",
        });
        const simplified = turf.simplify(buffered, {
            tolerance: 0.00001,
            highQuality: true,
        });
        const area = Math.round(turf.area(simplified));
        const customer = this.isoxmlManager.createEntityFromAttributes(TAGS.Customer, this.options.customer);
        this.isoxmlManager.registerEntity(customer);
        this.isoxmlManager.rootElement.attributes.Customer = [customer];
        const farm = this.isoxmlManager.createEntityFromAttributes(TAGS.Farm, this.options.farm);
        this.isoxmlManager.registerEntity(farm);
        this.isoxmlManager.rootElement.attributes.Farm = [farm];
        const coords = simplified.geometry.coordinates[0];
        if (coords[0] !== coords[coords.length - 1])
            coords.push(coords[0]);
        const isoPoints = coords.map(([lon, lat]) => this.isoxmlManager.createEntityFromAttributes(TAGS.Point, {
            PointEast: lon,
            PointNorth: lat,
            PointType: "10",
        }));
        const lineString = this.isoxmlManager.createEntityFromAttributes(TAGS.LineString, {
            LineStringType: LineStringLineStringTypeEnum.PolygonExterior,
            LineStringDesignator: "Outer partfield polygon",
            Point: isoPoints,
        });
        const polygon = this.isoxmlManager.createEntityFromAttributes(TAGS.Polygon, {
            PolygonType: PolygonPolygonTypeEnum.PartfieldBoundary,
            PolygonArea: area,
            LineString: [lineString],
        });
        const partfield = this.isoxmlManager.createEntityFromAttributes(TAGS.Partfield, {
            PartfieldDesignator: this.options.partfieldName,
            PartfieldArea: area,
            CustomerIdRef: this.isoxmlManager.getReferenceByEntity(customer),
            FarmIdRef: this.isoxmlManager.getReferenceByEntity(farm),
            PolygonnonTreatmentZoneonly: [polygon],
        });
        this.isoxmlManager.registerEntity(partfield);
        this.isoxmlManager.rootElement.attributes.Partfield = [partfield];
        const productGroup = this.isoxmlManager.createEntityFromAttributes(TAGS.ProductGroup, {
            ProductGroupDesignator: this.options.productGroupName,
            ProductGroupType: ProductGroupProductGroupTypeEnum.ProductGroupDefault,
        });
        this.isoxmlManager.registerEntity(productGroup);
        this.isoxmlManager.rootElement.attributes.ProductGroup = [productGroup];
        const valuePresentation = this.isoxmlManager.createEntityFromAttributes(TAGS.ValuePresentation, this.options.valuePresentation);
        this.isoxmlManager.registerEntity(valuePresentation);
        this.isoxmlManager.rootElement.attributes.ValuePresentation = [
            valuePresentation,
        ];
        const culturalPractice = this.isoxmlManager.createEntityFromAttributes(TAGS.CulturalPractice, {
            CulturalPracticeDesignator: this.options.culturalPracticeName,
        });
        this.isoxmlManager.registerEntity(culturalPractice);
        this.isoxmlManager.rootElement.attributes.CulturalPractice = [
            culturalPractice,
        ];
        const product = this.isoxmlManager.createEntityFromAttributes(TAGS.Product, {
            ProductDesignator: this.options.productName,
            ProductGroupIdRef: this.isoxmlManager.getReferenceByEntity(productGroup),
            ValuePresentationIdRef: this.isoxmlManager.getReferenceByEntity(valuePresentation),
            CulturalPracticeIdRef: this.isoxmlManager.getReferenceByEntity(culturalPractice),
            QuantityDDI: this.options.quantityDDI
                .toString(16)
                .toUpperCase()
                .padStart(4, "0"),
        });
        this.isoxmlManager.registerEntity(product);
        this.isoxmlManager.rootElement.attributes.Product = [product];
        const task = this.isoxmlManager.createEntityFromAttributes(TAGS.Task, {
            TaskDesignator: this.options.taskDesignator,
            CustomerIdRef: this.isoxmlManager.getReferenceByEntity(customer),
            FarmIdRef: this.isoxmlManager.getReferenceByEntity(farm),
            PartfieldIdRef: this.isoxmlManager.getReferenceByEntity(partfield),
            ProductGroupIdRef: this.isoxmlManager.getReferenceByEntity(productGroup),
            ProductIdRef: this.isoxmlManager.getReferenceByEntity(product),
            CulturalPracticeIdRef: this.isoxmlManager.getReferenceByEntity(culturalPractice),
            ValuePresentationIdRef: this.isoxmlManager.getReferenceByEntity(valuePresentation),
            TaskStatus: TaskTaskStatusEnum.Planned,
            DefaultTreatmentZoneCode: 1,
        });
        task.addGridFromGeoJSON(geoJson, this.options.gridDDI);
        this.isoxmlManager.registerEntity(task);
        this.isoxmlManager.rootElement.attributes.Task = [task];

        const zipData = await this.isoxmlManager.saveISOXML();
        this.saveFile(zipData, outputPath);
    }
}

export const SelectedActionDictionary = Object.freeze({
    PLANTING: 'Planting',
    CROP_PROTECTION: 'Protection',
    FERTILIZER: 'Fertilizer',
});

export const descriptionActionDictionary = Object.freeze({
    PLANTING: 'Seed1',
    CROP_PROTECTION: 'Proection1',
    FERTILIZER: 'Fertilizers1',
});

// export const ScaleDictionary = Object.freeze({
//     "kg/ha": 0.01, // 1 kg/ha = 1000 g / 10000 m² = 1000000 mg / 10000 m² = 100 mg/m²
//     "seeds/ha": 10, // 10 * value / 10000  (1 ha = 10000 m²)
//     "l/ha": 0.0001,  // 1 l/ha = 1000000 / 10000 mm³/m² = 100 mm³/m²
// });

export const ResolutionDictionary = Object.freeze({
    "kg/ha": 1, // based in DDI resolution , mg/m²
    "seeds/ha": 0.001, // based in DDI resolution , /m² 
    "l/ha": 0.01, // based in DDI resolution , mm³/m²
});

export const ConversionFactorDictionary = Object.freeze({
    "kg/ha": 100, // from kg/ha to mg/m²
    "seeds/ha": 0.0001, // from seed/ha to seed/m² 
    "l/ha": 100, // from l/ha to mm³/m²
});

export const QuantityDDIDictionary = Object.freeze({
    "kg/ha": 75,  // actual mass content (g)
    "seeds/ha": 78,  // actual count content (count)
    "l/ha": 72, // actual volume content (ml)
});

export const gridDDIDictionary = Object.freeze({
    "kg/ha": 6,  // Setpoint Mass Per Area Application Rate [mg/mÂ²], resolution: 1
    "seeds/ha": 11,  // Setpoint Count Per Area Application Rate [/mÂ²], resolution: 0.001
    "l/ha": 1, // Setpoint Volume Per Area Application Rate as [mmÂ³/mÂ²], resolution: 0.01
});


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

        this.state = {
            step: 0,
            step_dict: { 0: 'Initialization', 1: 'Fetching statistics', 2: 'Loading NDVI', 3: 'Getting NDVI', 4: 'Got NDVI', 5: 'Generate production map', 6: 'Getting GeoJSON', 7: 'Got GeoJSON', 8: 'Getting isoxml', 9: 'Got isoxml' },
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
            geoJson: null,
            selectedAction: null,
            selectedUnit: "kg/ha",
            zoneValues: [0.0, 0.0]
            //unitSystem
        };
    }

    componentDidMount() {
        //onUnitSystemChanged(this.unitsChanged);
    }

    componentDidUpdate(prevProps, prevState) {
        if (!prevState.productionMapLayer && this.state.productionMapLayer) {
            console.log("productionMapLayer is now visible");
            this.setState({ selectedAction: SelectedActionDictionary.PLANTING });
        }

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
                            //this.setState();
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
            this.taskAddGeoJSONFromURL = null;
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
                let availableColors = leafletColors.filter(color => !Object.values(labelColorCache).includes(color));
                // If no colors are available, reset the cache to allow reuse
                if (availableColors.length === 0) {
                    console.warn("All colors are used. Resetting color cache.");
                    labelColorCache = {};
                    availableColors = [...leafletColors];
                }
                // Pick a random color from the available colors
                const colorIndex = Math.floor(Math.random() * availableColors.length);
                labelColorCache[label] = availableColors[colorIndex];
            }
            return labelColorCache[label];
        };

        this.taskAddGeoJSONFromURL = $.getJSON(url)
            .done((geojson) => {
                try {
                    this.handleRemoveProductionLayer();

                    this.setState({
                        step: 7, geoJson: geojson,
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
        this.handleRemoveProductionLayer();

        const parsed = parseInt(event.target.value, 10);
        const current = this.state.zoneValues;
        const newValues = [...current];

        if (parsed > current.length) {
            for (let i = current.length; i < parsed; i++) {
                newValues.push(0.0);
            }
        } else {
            newValues.length = parsed;
        }

        this.setState({
            zoneCount: parsed,
            zoneValues: newValues,
        });
    };

    handleDownsampleChange = (event) => {
        const downsampleValue = parseFloat(event.target.value);
        if (!isNaN(downsampleValue) && downsampleValue >= 0) {
            this.setState({ downsampleSize: downsampleValue });
        } else {
            this.setState({ downsampleSize: 1.0 });
        }
    };

    handleUnitChange = (event) => {
        const selectedUnit = event.target.value;

        const resetZoneValues = this.state.zoneValues.map(() => 0);
    
        this.setState({
            selectedUnit: selectedUnit,
            zoneValues: resetZoneValues,
        });
    };

    handleZoneValueChange = (index, value) => {
        const step = ResolutionDictionary[this.state.selectedUnit] / ConversionFactorDictionary[this.state.selectedUnit];
        const parsedValue = parseFloat(value);
    
        if (!isNaN(parsedValue) && parsedValue >= 0) {
            // Scale values to integers to avoid floating-point precision issues
            const scaledValue = Math.round(parsedValue * 1e10);
            const scaledStep = Math.round(step * 1e10);
    
            if (scaledValue % scaledStep === 0) {
                const zoneValues = [...this.state.zoneValues];
                zoneValues[index] = parsedValue;
                this.setState({ zoneValues });
    
                console.log("Zone values updated:", zoneValues);
            } else {
                console.warn(`Invalid input: ${value}. Must be divisible by step: ${step}`);
            }
        } else {
            console.warn(`Invalid input: ${value}. Must be a positive number.`);
        }
    };

    handleExport = (zoneValues, geoJson, selectedAction, selectedUnit) => {

        console.log("GeoJSON handleExport:", geoJson);
        console.log("Zone handleExport:", zoneValues);

        const generator = new ISOXMLGenerator({
            zoneValues: zoneValues,
            geoJson: geoJson,
            bufferSize: 0.6,
            customer: {
                CustomerFirstName: "Frodo",
                CustomerLastName: "Baggins",
                CustomerCity: "Hobbiton",
                CustomerState: "Shire",
            },
            farm: {
                FarmDesignator: "Bag End Farm",
                FarmCity: "Hobbiton",
                FarmState: "Shire",
            },
            partfieldName: "Bag End Field",
            productGroupName: descriptionActionDictionary[selectedAction],
            culturalPracticeName: descriptionActionDictionary[selectedAction],
            productName: descriptionActionDictionary[selectedAction],
            valuePresentation: {
                Offset: 0,
                Scale: ResolutionDictionary[selectedUnit] / ConversionFactorDictionary[selectedUnit],
                NumberOfDecimals: 2,
                UnitDesignator: selectedUnit,
            },
            quantityDDI: QuantityDDIDictionary[selectedUnit],
            taskDesignator: "LoTR task",
            gridDDI: gridDDIDictionary[selectedUnit],
        });

        console.log("Generating ISOXML...");

        this.setState({ step: 8 });

        generator.generate("isoxml.zip").then(() => {
            console.log("ISOXML file saved to isoxml.zip");
            this.setState({ step: 9 });
        }).catch((err) => {
            console.error("Error generating ISOXML:", err);
            this.setState({ step: 7, error: err });
        });

    }

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
            zoneCount,
            geoJson,
            selectedUnit,
            selectedAction,
            zoneValues,
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

                    {productionMapLayer && (
                        <div className="row action-buttons justify-content-end">
                            <div className="col-sm-12 text-right">
                                <button
                                    className={`btn btn-sm btn-outline-primary square-button mx-2 ${this.state.selectedAction === SelectedActionDictionary.PLANTING ? 'active' : ''}`}
                                    onClick={() => this.setState({ selectedAction: SelectedActionDictionary.PLANTING })}
                                >
                                    <i className="fa fa-seedling fa-2x" />
                                    <div>{_(SelectedActionDictionary.PLANTING)}</div>
                                </button>
                                <button
                                    className={`btn btn-sm btn-outline-primary square-button mx-2 ${this.state.selectedAction === SelectedActionDictionary.CROP_PROTECTION ? 'active' : ''}`}
                                    onClick={() => this.setState({ selectedAction: SelectedActionDictionary.CROP_PROTECTION })}
                                >
                                    <i className="fa fa-spray-can fa-2x" />
                                    <div>{_(SelectedActionDictionary.CROP_PROTECTION)}</div>
                                </button>
                                <button
                                    className={`btn btn-sm btn-outline-primary square-button mx-2 ${this.state.selectedAction === SelectedActionDictionary.FERTILIZER ? 'active' : ''}`}
                                    onClick={() => this.setState({ selectedAction: SelectedActionDictionary.FERTILIZER })}
                                >
                                    <i className="fa fa-poo fa-2x" />
                                    <div>{_(SelectedActionDictionary.FERTILIZER)}</div>
                                </button>
                            </div>
                        </div>
                    )}

                    {productionMapLayer && (
                        <div className="row justify-content-end">
                            <div className="col-sm-6">
                                <label htmlFor="unitSelect" className="form-label">{_("Unit:")}</label>
                            </div>
                            <div className="col-sm-6">
                                <select
                                    id="unitSelect"
                                    className="form-control"
                                    value={this.state.selectedUnit}
                                    onChange={this.handleUnitChange}
                                >
                                    {this.state.selectedAction === SelectedActionDictionary.PLANTING && (
                                        <>
                                            <option value="kg/ha">kg/ha</option>
                                            <option value="seeds/ha">seeds/ha</option>
                                        </>
                                    )}
                                    {this.state.selectedAction === SelectedActionDictionary.CROP_PROTECTION && (
                                        <>
                                            <option value="kg/ha">kg/ha</option>
                                            <option value="l/ha">l/ha</option>
                                        </>
                                    )}
                                    {this.state.selectedAction === SelectedActionDictionary.FERTILIZER && (
                                        <>
                                            <option value="kg/ha">kg/ha</option>
                                            <option value="l/ha">l/ha</option>
                                        </>
                                    )}
                                </select>
                            </div>
                        </div>
                    )}

                    {productionMapLayer && this.state.zoneValues.map((value, index) => (
                        <div className="row mb-2" key={index}>
                            <div className="col-sm-6">
                                <label htmlFor={`zoneValue${index}`} className="form-label">
                                    {_("Zone")} {index + 1}:
                                </label>
                            </div>
                            <div className="col-sm-6">
                                <input
                                    id={`zoneValue${index}`}
                                    type="number"
                                    className="form-control"
                                    step={ResolutionDictionary[selectedUnit] / ConversionFactorDictionary[selectedUnit]}
                                    value={value}
                                    onChange={(e) => this.handleZoneValueChange(index, e.target.value)}
                                />
                            </div>
                        </div>
                    ))}

                    <div className="row action-buttons justify-content-end">
                        <div className="col-sm-12 text-right">
                            <button
                                title='Generate production map zones'
                                onClick={this.handleGenerateProductionMap}
                                disabled={step < 4 || (step >= 5 && step < 7)}
                                type="button"
                                className="btn btn-sm btn-primary btn-preview mx-2"
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
                                onClick={() => this.handleExport(zoneValues, geoJson, selectedAction, selectedUnit)}
                                disabled={step == 8}
                                type="button"
                                className="btn btn-sm btn-primary btn-preview mx-2"
                            >
                                {step == 8 ? (
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
