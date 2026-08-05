// Settings overrides for the webpack dev server and for Cypress component
// tests, both of which point OVERLEAF_CONFIG at this path.
//
// Intentionally empty. `libraries/settings` treats OVERLEAF_CONFIG as an
// optional overrides layer merged over `settings.defaults.js`, and skips it
// when the path does not resolve, so an empty object reproduces exactly what
// this environment did while the file was missing.
//
// The file has to exist all the same: `webpack.config.dev.js` lists it under
// `cache.buildDependencies`, and webpack refuses to persist its filesystem
// cache when a build dependency cannot be resolved. Without it every start is
// a cold build and each compile logs a `Caching failed for pack` warning.
module.exports = {}
