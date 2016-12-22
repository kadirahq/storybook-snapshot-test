/* eslint-disable */

import runTests from './test_runner';
import { getStorybook } from '@kadira/storybook';
import Runner from './test_runner';
import path from 'path';
import program from 'commander';
import chokidar from 'chokidar';
import EventEmitter from 'events';
import loadBabelConfig from '@kadira/storybook/dist/server/babel_config';
import { filterStorybook } from './util';
import runWithRequireContext from './require_context';
import { loadAndTweakWebpackConfig, runWebpack, evaluateStorybookConfig } from './webpack_helper';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const babel = require('babel-core');

program
  .option('-c, --config-dir [dir-name]',
          'Directory where to load Storybook configurations from')
  .option('-u, --update [boolean]', 'Update saved story snapshots')
  .option('-i, --update-interactive [boolean]',
          'Update saved story snapshots interactively')
  .option('-g, --grep [string]', 'Only test stories matching regexp')
  .option('-x, --exclude [string]', 'Exclude stories matching regexp')
  .option('-w, --watch [boolean]', 'Watch file changes and rerun tests')
  .option('--storyshot-dir [string]',
          'Path to the directory to store storyshots. Default is [config-dir]/__storyshots__')
  .option('--extension [string]', 'File extension to use for storyshot files. Default is `.shot`')
  .option('--polyfills [string]', 'Add global polyfills')
  .option('--loaders [string]', 'Add loaders')
  .option('--webpack', 'Use [config-dir]/webpack.config.js (default: false, disables --loaders)')
  .parse(process.argv);

const {
  configDir = './.storybook',
  polyfills: polyfillsPath = require.resolve('./default_config/polyfills.js'),
  loaders: loadersPath = require.resolve('./default_config/loaders.js'),
  grep,
  exclude,
  webpack = false,
} = program;

const configPath = path.resolve(configDir, 'config.js');

function createBabelConfig() {
  const babelConfig = loadBabelConfig(configDir);

  // cacheDir is webpack babel loader specific. We don't run webpack.
  delete babelConfig.cacheDirectory;

  require('babel-register')(babelConfig);
  require('babel-polyfill');

  // load loaders
  const loaders = require(path.resolve(loadersPath));

  Object.keys(loaders).forEach(ext => {
    const loader = loaders[ext];
    require.extensions[`.${ext}`] = (m, filepath) => {
      m.exports = loader(filepath);
    };
  })

  // load polyfills
  require(path.resolve(polyfillsPath));

  return babelConfig
};

function loadStorybookUsingBabel(babelConfig) {
  const content = babel.transformFileSync(configPath, babelConfig).code;
  const contextOpts = {
    filename: configPath,
    dirname: path.resolve(configDir),
  };
  runWithRequireContext(content, contextOpts);
  return require('@kadira/storybook').getStorybook();
};

async function loadStorybookUsingWebpack(webpackConfig) {
  const storybookConfig = await runWebpack(webpackConfig)
  return evaluateStorybookConfig(storybookConfig, polyfillsPath)  
}

const config = (webpack) ? loadAndTweakWebpackConfig(configDir) : createBabelConfig()

// set userAgent so storybook knows we're storyshots
if(!global.navigator) {
  global.navigator = {}
};
global.navigator.userAgent = 'storyshots';

const runner = new Runner(program);

async function main() {
  try {
    // Channel for addons is created by storybook manager from the client side.
    // We need to polyfill it for the server side.
    const addons = require('@kadira/storybook-addons').default;
    const channel = new EventEmitter();
    addons.setChannel(channel);

    const storybook = (webpack) ? await loadStorybookUsingWebpack(config) : loadStorybookUsingBabel(config);
        
    const result = await runner.run(filterStorybook(storybook, grep, exclude));
    const fails = result.errored + result.unmatched;
    const exitCode = fails > 0 ? 1: 0;
    if(!program.watch){
      process.exit(exitCode);
    }
  } catch (e) {
    console.log(e.stack || e);

    if(!program.watch){
      process.exit(1);
    }
  }
}

if (program.watch) {
  var watcher = chokidar.watch('.', {
    ignored: 'node_modules', // TODO: Should node_modules also be watched?
    persistent: true
  });

  watcher.on('ready', () => {
    console.log('\nStoryshots is in watch mode.\n');
    watcher.on('all', () => {
      // Need to remove the require cache. Because it containes modules before
      // changes were made.
      Object.keys(require.cache).forEach(key => {
        delete require.cache[key];
      });

      main();
    });
  });
}

main();
