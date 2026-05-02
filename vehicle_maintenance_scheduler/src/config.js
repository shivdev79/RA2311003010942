'use strict';

module.exports = {
  apiBaseURL: process.env.API_BASE_URL || 'http://20.207.122.201/evaluation-service',
  port:       process.env.VEHICLE_PORT || process.env.PORT || '8081',
};
