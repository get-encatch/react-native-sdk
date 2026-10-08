'use strict';

// Loads the optional peer 'expo-application'; exports null when it is not installed.
//
// Keep exactly one require per file, at module top level. Metro < 0.82.5
// (React Native <= 0.80) drops an unresolvable optional dependency from a
// module's dependency map without re-indexing the rest, and its runtime
// reports a failed require as fatal unless it runs during module
// initialisation. Isolated like this, a missing package only affects this
// module and the failure stays catchable.
try {
  module.exports = require('expo-application');
} catch (e) {
  module.exports = null;
}
