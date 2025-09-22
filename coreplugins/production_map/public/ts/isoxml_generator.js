import { ISOXMLManager, TAGS, TaskTaskStatusEnum, LineStringLineStringTypeEnum, ProductGroupProductGroupTypeEnum, PolygonPolygonTypeEnum } from "isoxml";
import { createGridParamsGenerator } from "isoxml/dist/entities/Grid/DefaultGridParamsGenerator";
import * as turf from "@turf/turf";

export class ISOXMLGenerator {
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
    async loadGeoJSON() {
        try {
            const response = await fetch(this.options.geoJSONPath);
            if (!response.ok) {
                throw new Error(`Failed to load GeoJSON file: ${response.statusText}`);
            }
            const geoJSON = await response.json();
            // Ensure the GeoJSON is a FeatureCollection
            if (geoJSON.type === "FeatureCollection") {
                return geoJSON;
            }
            else {
                throw new Error("Loaded GeoJSON is not a FeatureCollection.");
            }
        }
        catch (error) {
            console.error("Error loading GeoJSON:", error);
            throw error;
        }
    }
    saveFile(data, filename) {
        const blob = new Blob([data], { type: 'application/zip' }); // Create a Blob for the data
        const link = document.createElement('a'); // Create a temporary link element
        link.href = URL.createObjectURL(blob); // Create a URL for the Blob
        link.download = filename; // Set the filename for the download
        document.body.appendChild(link); // Append the link to the document
        link.click(); // Trigger the download
        document.body.removeChild(link); // Remove the link from the document
    }
    async generate(outputPath = "./isoxml.zip") {
        const geoJSON = await this.loadGeoJSON();
        const flattened = turf.flatten(geoJSON);
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
        task.addGridFromGeoJSON(geoJSON, this.options.gridDDI);
        this.isoxmlManager.registerEntity(task);
        this.isoxmlManager.rootElement.attributes.Task = [task];
        const zipData = await this.isoxmlManager.saveISOXML();
        this.saveFile(zipData, outputPath);
    }
}