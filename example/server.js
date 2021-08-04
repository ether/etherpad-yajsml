/*
 * Copyright (c) 2011 Chad Weider
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';

const fs = require('fs');
const connect = require('connect');
const cors = require('connect-cors');
const request = require('request');

// This needs to be a package.
const UglifyMiddleware = require('./uglify-middleware');
const compressor = new UglifyMiddleware();
compressor._console = console;

const Yajsml = require('etherpad-yajsml');
const associators = Yajsml.associators;

let configuration;
for (let i = 1, ii = process.argv.length; i < ii; i++) {
  if (process.argv[i] === '--configuration') {
    const configPath = process.argv[i + 1];
    if (!configPath) {
      throw new Error('Configuration option specified, but no path given.');
    } else {
      configuration = JSON.parse(fs.readFileSync(configPath));
    }
  }
}

if (!configuration) {
  throw new Error('No configuration option given.');
}

const assetServer = connect.createServer()
    .use(cors({
      origins: ['*'],
      methods: ['HEAD', 'GET'],
      headers: [
        'content-type',
        'accept',
        'date',
        'if-modified-since',
        'last-modified',
        'expires',
        'etag',
        'cache-control',
      ],
    }))
    .use(connect.cookieParser());
if (configuration.minify) {
  assetServer.use(compressor);
}

const interpolatePath = (path, values) => path && path.replace(
    /(\/)?:(\w+)/, (_, slash, key) => slash + encodeURIComponent((values || {})[key]));

const interpolateURL = (url, values) => {
  const parsed = new URL(url);
  if (parsed) {
    parsed.pathname = interpolatePath(parsed.pathname, values);
  }
  return parsed.href;
};

const handle = (req, res, next) => {
  const instanceConfiguration = {
    rootPath: configuration.rootPath && interpolatePath(configuration.rootPath, req.params),
    rootURI: configuration.rootURI && interpolateURL(configuration.rootURI, req.params),
    libraryPath:
        configuration.libraryPath && interpolatePath(configuration.libraryPath, req.params),
    libraryURI: configuration.libraryURI && interpolateURL(configuration.libraryURI, req.params),
  };
  const instance = new (Yajsml.Server)(instanceConfiguration);
  const respond = () => instance.handle(req, res, next);
  if (configuration.manifest) {
    request({
      url: interpolateURL(configuration.manifest, req.params),
      method: 'GET',
      encoding: 'utf8',
      timeout: 2000,
    }, (error, res, content) => {
      if (error || res.statusCode !== '200') {
        // Silently use default associator
        instance.setAssociator(new (associators.SimpleAssociator)());
      } else {
        try {
          const manifest = JSON.parse(content);
          const associations =
              associators.associationsForSimpleMapping(manifest);
          const associator = new (associators.StaticAssociator)(associations);
          instance.setAssociator(associator);
        } catch (e) {
          instance.setAssociator(new (associators.SimpleAssociator)());
        }
      }
      respond();
    });
  } else {
    instance.setAssociator(new (associators.SimpleAssociator)());
    respond();
  }
};

assetServer.use(connect.router((app) => {
  configuration.rootPath && app.all(`${configuration.rootPath}/*`, handle);
  configuration.libraryPath && app.all(`${configuration.libraryPath}/*`, handle);
}));

assetServer.listen(configuration.port || 8450);
