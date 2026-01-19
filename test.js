const { main } = require('./ForestCarbonEstimation.js');

async function example() {
  const keyPath = './gen-lang-client-0487226181-edaa2b0236d9.json';
  const coordinates = 
  [
    [72.7500, 26.9500],
    [72.8000, 26.9500],
    [72.8000, 26.9000],
    [72.7500, 26.9000]
  ]
  
  
  
  ;
  /*
  trees in Taman Negara commonly reach 30 to 50 meters.

 Some trees and younger growth typically range from 5 to 15 meters, which fits your 7–10 m range.

 Species like Dipterocarps, dominant in the region, are known to be among the tallest tropical trees.
  */

 /*
  Location_ID: 1042
Features:
  - Sentinel-1_VV_IQR: 0.03  # VV polarization: sensitive to ground moisture and surface roughness.
  - Sentinel-1_VH_IQR: 0.02  # VH polarization: highlights vegetation structure and volume scattering.
  
  # Sentinel-2 Spectral Bands (Top-of-Atmosphere Reflectance or Surface Reflectance)
  - Sentinel-2_B2: 0.03  # BLUE: useful for bathymetric mapping and detecting healthy vs stressed vegetation.
  - Sentinel-2_B3: 0.05  # GREEN: highlights plant vigor and is useful for visual vegetation indices.
  - Sentinel-2_B4: 0.04  # RED: absorbed by chlorophyll; low value => dense healthy vegetation.
  - Sentinel-2_B5: 0.18  # RED EDGE 1: sensitive to leaf chlorophyll content and vegetation stress.
  - Sentinel-2_B6: 0.22  # RED EDGE 2: helps detect subtle changes in vegetation health.
  - Sentinel-2_B7: 0.30  # RED EDGE 3: useful in canopy structure and biomass estimation.
  - Sentinel-2_B8: 0.45  # Near Infrared (NIR): high reflectance => healthy vegetation, high biomass.
  - Sentinel-2_B11: 0.12 # Shortwave Infrared 1 (SWIR1): sensitive to vegetation water content and leaf moisture.
  - Sentinel-2_B12: 0.10 # Shortwave Infrared 2 (SWIR2): useful for detecting burned areas and moisture stress.
  
  - Sentinel-2_NDVI: 0.84  # Normalized Difference Vegetation Index: indicates vegetation health and moisture.
  
  # Topographic Features
  - Elevation: 320  # in meters; from SRTM or similar DEM.
  - Slope: 12       # in degrees; derived from elevation raster.
  
  # Land Cover Category
  - Land_Cover: 10  # Dense vegetation or forested land (category depends on classification schema).
  
Target:
  - Canopy_Height: 32  # in meters; from NASA GEDI lidar mission.

 */
/*
Biomass = a × (Height)^b
Carbon eq = 0.47 * Biomass
*/
  const options = {
    startDate: '2023-04-01',
    endDate: '2023-06-30',
    numSamples: 5000,
    splitRatio: 0.7,
    exportToGDrive: true
  };

  try {
    const results = await main(keyPath, coordinates, options);
    console.log('Results:', results);
  } catch (error) {
    console.error('Failed to run estimation:', error);
  }
}

example();