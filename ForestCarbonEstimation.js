const ee = require('@google/earthengine');
const fs = require('fs');
const path = require('path');

// Simple terminal styling without external dependencies
const termStyles = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',
  hidden: '\x1b[8m',
  // Colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  // Background
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

class ForestCarbonEstimation {
  constructor(keyPath, boundaryCoordinates) {
    this.keyPath = keyPath;
    this.boundaryCoordinates = boundaryCoordinates;
    this.initialized = false;
    this.trainingData = null;
    this.validationData = null;
    
    this.vegetationParams = {
      10: { a: 0.0776, b: 1.58, name: 'Dense Forest' },
      20: { a: 0.0500, b: 1.35, name: 'Shrubland' },
      30: { a: 0.0350, b: 1.20, name: 'Grassland' },
      40: { a: 0.0250, b: 1.10, name: 'Cropland' },
      50: { a: 0.0000, b: 0.00, name: 'Built-up' },
      60: { a: 0.0100, b: 1.00, name: 'Sparse Vegetation' },
      70: { a: 0.0000, b: 0.00, name: 'Snow and Ice' },
      80: { a: 0.0000, b: 0.00, name: 'Water Bodies' },
      90: { a: 0.0450, b: 1.25, name: 'Wetland' },
      95: { a: 0.0900, b: 1.65, name: 'Mangroves' },
      100: { a: 0.0200, b: 1.05, name: 'Moss and Lichen' }
    };
  }

  createBoundary(coordinates) {
    if (!coordinates || !coordinates.length) {
      coordinates = [
        [102.326, 4.422],
        [102.326, 4.321],
        [102.456, 4.321],
        [102.456, 4.422]
      ];
    }
    return ee.Geometry.Polygon(coordinates);
  }

  async initialize() {
    try {
      if (!fs.existsSync(this.keyPath)) {
        throw new Error(`Private key file not found at ${this.keyPath}`);
      }

      const privateKey = JSON.parse(fs.readFileSync(this.keyPath, 'utf8'));

      return new Promise((resolve, reject) => {
        ee.data.authenticateViaPrivateKey(
          privateKey,
          () => {
            ee.initialize(
              null,
              null,
              () => {
                this.initialized = true;
                console.log('Google Earth Engine initialized');
                resolve();
              },
              (error) => reject(new Error(`Initialization error: ${error}`))
            );
          },
          (error) => reject(new Error(`Authentication error: ${error}`))
        );
      });
    } catch (err) {
      throw new Error(`Failed to initialize: ${err.message}`);
    }
  }

  createBoundaryFeature() {
    return ee.FeatureCollection([ee.Feature(this.boundary)]);
  }

  loadSentinel1Data(startDate = '2021-04-01', endDate = '2021-06-30') {
    const collection = ee.ImageCollection('COPERNICUS/S1_GRD')
      .filterDate(startDate, endDate)
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
      .filter(ee.Filter.eq('instrumentMode', 'IW'))
      .filter(ee.Filter.eq('orbitProperties_pass', 'ASCENDING'))
      .filterBounds(this.boundary);

    const percentile = collection.reduce(ee.Reducer.percentile([25, 50, 75]));
    const linear = ee.Image(10).pow(percentile.divide(10));
    const features = linear.select(['VH_p50', 'VV_p50'])
      .clip(this.boundary)
      .reproject({ crs: 'EPSG:32647', scale: 30 });

    return features
      .addBands(linear.select('VV_p75').subtract(linear.select('VV_p25')).rename('VV_iqr'))
      .addBands(linear.select('VH_p75').subtract(linear.select('VH_p25')).rename('VH_iqr'));
  }

  maskS2clouds(image) {
    const qa = image.select('QA60');
    const cloudBitMask = 1 << 10;
    const cirrusBitMask = 1 << 11;
    const mask = qa.bitwiseAnd(cloudBitMask).eq(0)
      .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
    return image.updateMask(mask).divide(10000);
  }

  loadSentinel2Data(startDate = '2021-04-01', endDate = '2021-06-30') {
    return ee.ImageCollection('COPERNICUS/S2_SR')
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
      .map(this.maskS2clouds)
      .select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B11', 'B12'])
      .median()
      .clip(this.boundary)
      .reproject({ crs: 'EPSG:32647', scale: 30 });
  }

  loadTerrainData() {
    const elevation = ee.Image("USGS/SRTMGL1_003")
      .clip(this.boundary)
      .reproject({ crs: 'EPSG:32647', scale: 30 })
      .rename('elevation');
    
    const slope = ee.Terrain.slope(elevation)
      .clip(this.boundary)
      .reproject({ crs: 'EPSG:32647', scale: 30 })
      .rename('slope');
    
    return { elevation, slope };
  }

  loadLandCoverData() {
    return ee.ImageCollection("ESA/WorldCover/v100")
      .first()
      .clip(this.boundary)
      .reproject({ crs: 'EPSG:32647', scale: 30 })
      .rename('landcover');
  }

  async calculateVegetationAreas(landCover) {
    const areaImage = ee.Image.pixelArea().divide(10000);
    const histogram = await landCover.reduceRegion({
      reducer: ee.Reducer.frequencyHistogram(),
      geometry: this.boundary,
      scale: 30,
      maxPixels: 1e13
    }).get('landcover').getInfo();

    return Object.keys(this.vegetationParams)
      .map(Number)
      .filter(classId => histogram[classId])
      .map(classId => ({
        id: classId,
        name: this.vegetationParams[classId].name,
        area: histogram[classId],
        aParams: this.vegetationParams[classId]
      }))
      .sort((a, b) => b.area - a.area);
  }

  qualityMask(image) {
    return image.updateMask(image.select('quality_flag').eq(1));
  }

  loadGEDIData() {
    return ee.ImageCollection('LARSE/GEDI/GEDI02_A_002_MONTHLY')
      .filterBounds(this.boundary)
      .filterDate('2020-01-01', '2023-12-31')
      .map(this.qualityMask)
      .select('rh98');
  }

  createStratifiedSamplePoints(gediData, landCover, numSamples = 2000) {
    const combined = gediData.mosaic().addBands(landCover);
    return combined.stratifiedSample({
      numPoints: numSamples,
      classBand: 'landcover',
      region: this.boundary,
      scale: 30,
      seed: 66,
      geometries: true
    }).randomColumn('random', 27);
  }

  splitTrainingData(data, splitRatio = 0.7) {
    this.trainingData = data.filter(ee.Filter.lt('random', splitRatio));
    this.validationData = data.filter(ee.Filter.gte('random', splitRatio));
    return { trainingData: this.trainingData, validationData: this.validationData };
  }

  trainModel(mergedData, trainingData, bands) {
    const training = mergedData.select(bands).sampleRegions({
      collection: trainingData,
      properties: ['rh98'],
      scale: 30
    });

    return ee.Classifier.smileRandomForest(50)
      .setOutputMode('REGRESSION')
      .train({
        features: training,
        classProperty: 'rh98',
        inputProperties: bands
      });
  }

  async runRegression(mergedData, classifier, bands, trainingData, validationData) {
    const regression = mergedData.select(bands)
      .classify(classifier, 'predicted')
      .clip(this.boundary);

    const [trainingRMSE, validationRMSE, rSquared] = await Promise.all([
      this.calculateRMSE(regression, trainingData),
      this.calculateRMSE(regression, validationData),
      this.calculateRSquared(regression, validationData)
    ]);

    return { regression, metrics: { trainingRMSE, validationRMSE, rSquared } };
  }

  async calculateRMSE(regression, data) {
    const predicted = regression.sampleRegions({
      collection: data,
      properties: ['rh98'],
      scale: 30
    });

    const errorCollection = predicted.map(function(feature) {
      const actual = ee.Number(feature.get('rh98'));
      const pred = ee.Number(feature.get('predicted'));
      const residual = actual.subtract(pred).pow(2);
      return feature.set('squared_error', residual);
    });

    const meanSquaredError = await errorCollection
      .aggregate_mean('squared_error')
      .getInfo();
      
    return Math.sqrt(meanSquaredError);
  }

  async calculateRSquared(regression, data) {
    const predicted = regression.sampleRegions({
      collection: data,
      properties: ['rh98'],
      scale: 30
    });

    const meanActual = await predicted.aggregate_mean('rh98').getInfo();
    
    const withErrors = predicted.map(function(feature) {
      const actual = ee.Number(feature.get('rh98'));
      const pred = ee.Number(feature.get('predicted'));
      const residual = actual.subtract(pred).pow(2);
      const totalError = actual.subtract(meanActual).pow(2);
      return feature.set({
        'squared_residual': residual,
        'squared_total': totalError
      });
    });
    
    const residualSS = await withErrors
      .aggregate_sum('squared_residual')
      .getInfo();
      
    const totalSS = await withErrors
      .aggregate_sum('squared_total')
      .getInfo();
    
    if (totalSS === 0) return 0;
    return 1 - (residualSS / totalSS);
  }

  async calculateCarbonStocks(regression, landCover) {
    const vegetationAreas = await this.calculateVegetationAreas(landCover);
    const totalArea = vegetationAreas.reduce((sum, veg) => sum + veg.area, 0);

    const vegetationCarbon = await Promise.all(vegetationAreas.map(async veg => {
      const mask = landCover.eq(veg.id);
      const stats = await regression.select('predicted').updateMask(mask)
        .reduceRegion({
          reducer: ee.Reducer.mean().combine({
            reducer2: ee.Reducer.stdDev(),
            sharedInputs: true
          }),
          geometry: this.boundary,
          scale: 30,
          maxPixels: 1e9
        }).getInfo();

      const heightMean = stats.predicted_mean || 0;
      const { a, b } = veg.aParams;
      const biomass = Math.pow(heightMean, b) * a;
      const carbonStock = biomass * 0.47 * veg.area;

      let annualRate;
      switch (veg.id) {
        case 10: annualRate = 0.025; break;
        case 20: annualRate = 0.020; break;
        case 30: annualRate = 0.015; break;
        case 90: annualRate = 0.030; break;
        case 95: annualRate = 0.035; break;
        default: annualRate = 0.010;
      }

      return {
        id: veg.id,
        name: veg.name,
        area: veg.area,
        areaPercent: (veg.area / totalArea * 100).toFixed(2),
        carbonParameters: { a, b, sequestrationRate: annualRate },
        heightStatistics: { mean: heightMean, stdDev: stats.predicted_stdDev || 0 },
        carbonStock,
        annualSequestration: carbonStock * annualRate,
        co2Equivalent: carbonStock * 3.67
      };
    }));

    return {
      vegetationCarbon,
      totalArea,
      totalCarbon: vegetationCarbon.reduce((sum, veg) => sum + veg.carbonStock, 0),
      totalAnnualSeq: vegetationCarbon.reduce((sum, veg) => sum + veg.annualSequestration, 0),
      totalCO2Eq: vegetationCarbon.reduce((sum, veg) => sum + veg.co2Equivalent, 0)
    };
  }

  visualizeLandcover(landCover) {
    console.log('Generating visualization URL for landcover...');
    
    const visParams = {
      min: 10,
      max: 100,
      palette: [
        '006400', // Dense Forest (10) - dark green
        'FFBB22', // Shrubland (20) - orange
        'FFFF4C', // Grassland (30) - yellow
        'F096FF', // Cropland (40) - pink
        'FA0000', // Built-up (50) - red
        'B4B4B4', // Sparse Vegetation (60) - gray
        'F0F0F0', // Snow and Ice (70) - light gray
        '0064C8', // Water Bodies (80) - blue
        '0096A0', // Wetland (90) - teal
        '00CF75', // Mangroves (95) - bright green
        'FAE6A0'  // Moss and Lichen (100) - tan
      ]
    };
    
    return landCover.getThumbURL({
      dimensions: '1000',
      region: this.boundary,
      format: 'png',
      min: visParams.min,
      max: visParams.max,
      palette: visParams.palette
    });
  }

  visualizeCanopyHeight(regression) {
    console.log('Generating visualization URL for canopy height...');
    
    const visParams = {
      min: 0,
      max: 30,
      palette: [
        'FFFFFF', // 0m - white
        'CE7E45', // 5m - light brown
        'DF923D', // 10m - tan
        'F1B555', // 15m - light yellow
        'FCD163', // 20m - yellow
        '99B718', // 25m - light green
        '74A901', // 30m - green
        '66A000', // 35m - dark green
        '529400', // 40m - darker green
        '3E8601', // 45m - very dark green
        '207401'  // 50m+ - deepest green
      ]
    };
    
    return regression.select('predicted').getThumbURL({
      dimensions: '1000',
      region: this.boundary,
      format: 'png',
      min: visParams.min,
      max: visParams.max,
      palette: visParams.palette
    });
  }

  async displayConsoleVisualization(regression, landCover) {
    console.log('\n========= CONSOLE VISUALIZATION =========');
    
    console.log('\nLand Cover Classification:');
    const landcoverURL = this.visualizeLandcover(landCover);
    console.log(`Land cover visualization URL: ${landcoverURL}`);
    console.log('\nLand Cover Legend:');
    Object.entries(this.vegetationParams).forEach(([id, data]) => {
      console.log(`${termStyles.bold}${id}${termStyles.reset}: ${data.name}`);
    });
    
    console.log('\nPredicted Canopy Height:');
    const canopyURL = this.visualizeCanopyHeight(regression);
    console.log(`Canopy height visualization URL: ${canopyURL}`);
    
    console.log('\nSimplified ASCII Canopy Height Map:');
    
    try {
      const samples = await regression.select('predicted').sampleRectangle({
        region: this.boundary,
        properties: ['predicted'],
        defaultValue: 0,
        numLines: 20,
        numPixels: 60
      }).get('predicted').getInfo();
      
      if (samples && samples.length) {
        const maxHeight = Math.max(...samples.flat().filter(h => !isNaN(h)));
        
        samples.forEach(row => {
          let line = '';
          row.forEach(height => {
            if (isNaN(height) || height === null) {
              line += ' ';
            } else {
              const normalizedHeight = height / maxHeight;
              if (normalizedHeight < 0.1) line += ' ';
              else if (normalizedHeight < 0.2) line += '.';
              else if (normalizedHeight < 0.3) line += ':';
              else if (normalizedHeight < 0.4) line += '-';
              else if (normalizedHeight < 0.5) line += '=';
              else if (normalizedHeight < 0.6) line += '+';
              else if (normalizedHeight < 0.7) line += '*';
              else if (normalizedHeight < 0.8) line += '#';
              else if (normalizedHeight < 0.9) line += '%';
              else line += '@';
            }
          });
          console.log(line);
        });
        
        console.log('\nHeight Legend:');
        console.log(' (empty): 0m');
        console.log('.: 0-3m');
        console.log(':: 3-6m');
        console.log('-: 6-9m');
        console.log('=: 9-12m');
        console.log('+: 12-15m');
        console.log('*: 15-18m');
        console.log('#: 18-21m');
        console.log('%: 21-27m');
        console.log('@: 27m+');
      } else {
        console.log('Unable to generate ASCII visualization - no data returned');
      }
    } catch (error) {
      console.log('Error generating ASCII visualization:', error.message);
    }
  }

  async run(options = {}) {
    try {
      if (!this.initialized) await this.initialize();

      this.boundary = this.createBoundary(this.boundaryCoordinates);
      const boundaryFeature = this.createBoundaryFeature();

      console.log('Loading data sources...');
      const [landCover, s1Data, s2Data, terrainData, gediData] = await Promise.all([
        this.loadLandCoverData(),
        this.loadSentinel1Data(options.startDate, options.endDate),
        this.loadSentinel2Data(options.startDate, options.endDate),
        this.loadTerrainData(),
        this.loadGEDIData()
      ]);

      const { elevation, slope } = terrainData;
      console.log('Calculating vegetation areas...');
      const vegetationAreas = await this.calculateVegetationAreas(landCover);
      console.log('Creating sample points...');
      const samplePoints = this.createStratifiedSamplePoints(gediData, landCover, options.numSamples);
      console.log('Splitting training data...');
      const { trainingData, validationData } = this.splitTrainingData(samplePoints, options.splitRatio);

      const mergedData = s2Data
        .addBands(s1Data)
        .addBands(elevation)
        .addBands(slope)
        .addBands(landCover)
        .clip(this.boundary);

      const bands = [
        'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B11', 'B12',
        'VV_iqr', 'VH_iqr', 'elevation', 'slope', 'landcover'
      ];

      console.log('Training model...');
      const classifier = this.trainModel(mergedData, trainingData, bands);
      console.log('Running regression...');
      const { regression, metrics } = await this.runRegression(mergedData, classifier, bands, trainingData, validationData);
      console.log('Calculating carbon stocks...');
      const carbonData = await this.calculateCarbonStocks(regression, landCover);

      await this.displayConsoleVisualization(regression, landCover);

      return {
        boundary: await boundaryFeature.getInfo(),
        vegetationAreas,
        regressionStats: {
          min: await regression.select('predicted').reduceRegion({
            reducer: ee.Reducer.min(),
            geometry: this.boundary,
            scale: 30,
            maxPixels: 1e13
          }).get('predicted').getInfo(),
          max: await regression.select('predicted').reduceRegion({
            reducer: ee.Reducer.max(),
            geometry: this.boundary,
            scale: 30,
            maxPixels: 1e13
          }).get('predicted').getInfo(),
          mean: await regression.select('predicted').reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: this.boundary,
            scale: 30,
            maxPixels: 1e13
          }).get('predicted').getInfo()
        },
        metrics,
        trainingSampleSize: await trainingData.size().getInfo(),
        validationSampleSize: await validationData.size().getInfo(),
        carbonData
      };
    } catch (error) {
      console.error('Error in workflow:', error);
      throw error;
    }
  }

  // New method to determine tier based on provided criteria
  determineTier(carbonData, regressionStats, vegetationAreas) {
    const denseForest = vegetationAreas.find(veg => veg.id === 10) || { area: 0 };
    const totalArea = carbonData.totalArea;
    const denseForestPercent = (denseForest.area / totalArea) * 100;
    const co2PerHa = carbonData.totalCO2Eq / totalArea;
    const seqPerHa = carbonData.totalAnnualSeq / totalArea;
    const meanCanopy = regressionStats.mean;
    console.log(`denseForestPercent: ${denseForestPercent}, co2PerHa: ${co2PerHa}, seqPerHa: ${seqPerHa}, meanCanopy: ${meanCanopy}`);
    if (denseForestPercent > 70 && co2PerHa > 3 && meanCanopy > 10) {
      return 'Platinum';
    } else if (denseForestPercent >= 30 && co2PerHa >= 2 && meanCanopy > 7) {
      return 'Gold';
    } else if (denseForestPercent >= 10 && co2PerHa >= 1 && meanCanopy > 5) {
      return 'Silver';
    } else if (denseForestPercent >= 1 && co2PerHa < 1 && meanCanopy < 5) {
      return 'Bronze';
    } else {
      return 'Grey';
    }
  }
}

async function main(keyPath, coordinates, options = {}) {
  try {
    const estimator = new ForestCarbonEstimation(keyPath, coordinates);
    const results = await estimator.run({
      numSamples: 2000,
      splitRatio: 0.7,
      ...options
    });

    console.log('\n========= SUMMARY RESULTS =========');
    console.log(`${termStyles.bold}Total Area (ha):${termStyles.reset} ${results.carbonData.totalArea.toFixed(2)}`);
    console.log(`${termStyles.bold}Total Carbon Stock (tonnes):${termStyles.reset} ${results.carbonData.totalCarbon.toFixed(2)}`);
    console.log(`${termStyles.bold}Annual Carbon Sequestration (tonnes/year):${termStyles.reset} ${results.carbonData.totalAnnualSeq.toFixed(2)}`);
    console.log(`${termStyles.bold}Total CO2 Equivalent (tonnes):${termStyles.reset} ${results.carbonData.totalCO2Eq.toFixed(2)}`);
    console.log(`${termStyles.bold}Model R-squared:${termStyles.reset} ${results.metrics.rSquared.toFixed(4)}`);
    
    console.log('\n------------ Vegetation Breakdown ------------');
    console.log('| Vegetation Type | Area (ha) | % of Total | Carbon Stock (t) | Annual Seq. (t/yr) |');
    console.log('|----------------|-----------|------------|-----------------|-------------------|');
    results.carbonData.vegetationCarbon.forEach(veg => {
      console.log(`| ${veg.name.padEnd(14)} | ${veg.area.toFixed(2).padEnd(9)} | ${veg.areaPercent.padEnd(10)} | ${veg.carbonStock.toFixed(2).padEnd(15)} | ${veg.annualSequestration.toFixed(2).padEnd(17)} |`);
    });
    
    console.log('\n========= MODEL STATISTICS =========');
    console.log('Training Sample Size:', results.trainingSampleSize);
    console.log('Validation Sample Size:', results.validationSampleSize);
    console.log('Training RMSE:', results.metrics.trainingRMSE.toFixed(4));
    console.log('Validation RMSE:', results.metrics.validationRMSE.toFixed(4));
    console.log('R-squared:', results.metrics.rSquared.toFixed(4));
    console.log('Canopy Height Min (m):', results.regressionStats.min.toFixed(2));
    console.log('Canopy Height Max (m):', results.regressionStats.max.toFixed(2));
    console.log('Canopy Height Mean (m):', results.regressionStats.mean.toFixed(2));

    // Determine tier
    const tier = estimator.determineTier(results.carbonData, results.regressionStats, results.vegetationAreas);
    console.log(`${termStyles.bold}Forest Carbon Tier:${termStyles.reset} ${tier}`);

    return {
      tier,
      coordinates,
      carbonStock: results.carbonData.totalCarbon,
      sequestration: results.carbonData.totalAnnualSeq
    };
  } catch (error) {
    console.error('Execution failed:', error);
    process.exit(1);
  }
}

// Example usage
// const keyPath = './path/to/your/private-key.json';
// const coordinates = [
//   [102.326, 4.422],
//   [102.326, 4.321],
//   [102.456, 4.321],
//   [102.456, 4.422]
// ];
// main(keyPath, coordinates, {
//   startDate: '2021-04-01',
//   endDate: '2021-06-30'
// });

module.exports = { ForestCarbonEstimation, main };