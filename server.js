/* !

  Copyright (c) 2011 Chad Weider

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.

*/

const crypto = require('crypto');
const fs = require('fs');
const urlutil = require('url');
const requestURI = require('./request').requestURI;
const requestURIs = require('./request').requestURIs;

const HEADER_WHITELIST =
    ['date', 'last-modified', 'expires', 'cache-control', 'content-type'];

function hasOwnProperty(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function relativePath(path, rootPath) {
  const pathSplit = path.split('/');
  const rootSplit = rootPath.split('/');
  let relative;
  let i = 0;
  while (pathSplit[i] == rootSplit[i]) {
    i++;
  }
  if (i < rootSplit.length - 1) {
    relative = (new Array(rootSplit.length - i)).join('../');
  } else {
    relative = ''; // perhaps './'?
  }
  return relative + pathSplit.slice(i).join('/');
}

// Normal `path.normalize` uses backslashes on Windows, so this is a custom
// implimentation, sigh.
function normalizePath(path) {
  const pathComponents1 = path.split('/');
  const pathComponents2 = [];

  let component;
  for (let i = 0, ii = pathComponents1.length; i < ii; i++) {
    component = pathComponents1[i];
    switch (component) {
      case '':
        if (i == ii - 1) {
          pathComponents2.push(component);
          break;
        }
      case '.':
        if (i == 0) {
          pathComponents2.push(component);
        }
        break;
      case '..':
        if (pathComponents2.length > 1 ||
          (pathComponents2.length == 1 &&
            pathComponents2[0] != '' &&
            pathComponents2[0] != '.')) {
          pathComponents2.pop();
          break;
        }
      default:
        pathComponents2.push(component);
    }
  }

  return pathComponents2.join('/');
}

// OSWASP Guidlines: escape all non alphanumeric characters in ASCII space.
const escapeNonAlphanumerics = (text, exceptions) => text && text.replace(
    /[^0-9A-Za-z]/g,
    (c) => exceptions && exceptions.includes(c)
      ? c
      : `\\u${(`000${c.charCodeAt(0).toString(16)}`).slice(-4)}`);

// Only allow a subset of JavaScript expressions that are reasonable and cannot
// look like HTML (e.g. `require.define`, `requireForKey("key").define`).
const JSONP_CALLBACK_EXPRESSION = /^[a-zA-Z0-9$:._'"\\()\[\]\{\}]+$/;

function mixin(object1, object2, objectN) {
  const object = {};
  for (let i = 0, ii = arguments.length; i < ii; i++) {
    const o = arguments[i];
    for (const key in o) {
      if (hasOwnProperty(o, key)) {
        object[key] = o[key];
      }
    }
  }
  return object;
}

function selectProperties(o, keys) {
  const object = {};
  for (let i = 0, ii = keys.length; i < ii; i++) {
    const key = keys[i];
    if (hasOwnProperty(o, key)) {
      object[key] = o[key];
    }
  }
  return object;
}

function validateURI(uri) {
  const parsed = urlutil.parse(uri);
  if (parsed.protocol != 'file:' &&
      parsed.protocol != 'http:' &&
      parsed.protocol != 'https:') {
    throw `Invalid URI: ${JSON.stringify(uri)}.`;
  }
}

// Request HEAD for the given resources and return the composition of all
// responses. Each response is merged in a way preserves the repeatability and
// meaning of the aggregate. If any response can not be merged cleanly the
// result will be `undefined`.
function mergeHeaders(h_1, h_2, h_n) {
  const headersList = Array.prototype.slice.call(arguments, 0);
  const headers = {};

  let values, value;
  values = headersList.map((h) => Date.parse(h.date));
  if (values.every((value) => !isNaN(value))) {
    value = Math.max.apply(this, values);
    headers.date = (new Date(value)).toUTCString();
  }

  values = headersList.map((h) => Date.parse(h['last-modified']));
  if (values.every((value) => !isNaN(value))) {
    value = Math.max.apply(this, values);
    headers['last-modified'] = (new Date(value)).toUTCString();
  }

  values = headersList.map((h) => Date.parse(h.expires));
  if (values.every((value) => !isNaN(value))) {
    value = Math.min.apply(this, values);
    headers.expires = (new Date(value)).toUTCString();
  }

  values = headersList.map((h) => {
    const expires = (h['cache-control'] || '').match(/(?:max-age=(\d+))?/)[1];
    return parseInt(expires, 10);
  });
  if (values.every((value) => !isNaN(value))) {
    value = Math.min.apply(this, values);
    headers['cache-control'] = `max-age=${value.toString(10)}`;
  }

  return headers;
}

function packagedDefine(JSONPCallback, moduleMap) {
  content = `${JSONPCallback}({`;
  for (path in moduleMap) {
    if (hasOwnProperty(moduleMap, path)) {
      content += `"${escapeNonAlphanumerics(path, './-_')}": `;
      if (moduleMap[path] === null) {
        content += 'null';
      } else {
        // Note: This is a regular function, not an arrow function, so that the require kernel can
        // set the context (`this` inside the module) to `module.exports` to match Node.js's
        // behavior.
        content += `function (require, exports, module) {${moduleMap[path]}}`;
      }
      content += ',\n';
    }
  }
  content += '});\n';

  return content;
}

function notModified(requestHeaders, responseHeaders) {
  const lastModified = Date.parse(responseHeaders['last-modified']);
  const modifiedSince = Date.parse(requestHeaders['if-modified-since']);
  return ((requestHeaders.etag && requestHeaders.etag == responseHeaders.etag) ||
      (lastModified && lastModified <= modifiedSince));
}

/*
  I implement a JavaScript module server.
*/
function Server(options) {
  function trailingSlash(path) {
    if (path && path.charAt(path.length - 1) != '/') {
      return `${path}/`;
    } else {
      return path;
    }
  }
  function leadingSlash(path) {
    if (path && path.charAt(0) != '/') {
      return `/${path}`;
    } else {
      return path;
    }
  }

  if (options.rootURI) {
    this._rootURI = trailingSlash(options.rootURI);
    validateURI(this._rootURI);
    if (options.rootPath || options.rootPath == '') {
      this._rootPath = options.rootPath.toString();
    } else {
      this._rootPath = 'root';
    }
    this._rootPath = leadingSlash(trailingSlash(this._rootPath));
  }

  if (options.libraryURI) {
    this._libraryURI = trailingSlash(options.libraryURI);
    validateURI(this._rootURI);
    if (options.libraryPath || options.libraryPath == '') {
      this._libraryPath = options.libraryPath.toString();
    } else {
      this._libraryPath = 'library';
    }
    this._libraryPath = leadingSlash(trailingSlash(this._libraryPath));
  }

  if (this._rootPath && this._libraryPath &&
      (this._rootPath.indexOf(this._libraryPath) == 0 ||
        this._libraryPath.indexOf(this._rootPath) == 0)) {
    throw `The paths ${JSON.stringify(this._rootPath)} and ${
      JSON.stringify(this._libraryPath)} are ambiguous.`;
  }

  if (options.baseURI) {
    this._baseURI = trailingSlash(options.baseURI);
  }

  // Some clients insist on transforming values, but cannot run transformation
  // on a separate service. This enables a workaround #hack.
  if (options.requestURIs) {
    this._requestURIs = options.requestURIs;
  }
}
Server.prototype = new function () {
  function _resourceURIForModulePath(path) {
    if (path.charAt(0) == '/') {
      return this._rootURI + path.slice(1);
    } else {
      return this._libraryURI + path;
    }
  }

  function setAssociator(associator) {
    this._associator = associator;
  }

  function handle(request, response, next) {
    var requestURIs = this._requestURIs || requestURIs; // Hack, see above.
    var url = require('url');
    try {
      url = url.parse(request.url, true);
    } catch (e) {
      response.writeHead(422, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.write('422: Malformed URL');
      response.end();
      return;
    }
    var url = require('url').parse(request.url, true);
    const path = normalizePath(url.pathname);

    let modulePath;
    if (path.indexOf(this._rootPath) == 0) {
      modulePath = `/${path.slice(this._rootPath.length)}`;
    } else if (this._libraryURI && path.indexOf(this._libraryPath) == 0) {
      modulePath = path.slice(this._libraryPath.length);
    } else {
      // Something has gone wrong.
    }

    const requestHeaders = mixin({
      'user-agent': 'yajsml',
      'accept': '*/*',
    }
    , selectProperties(
        request.headers
        , ['if-modified-since', 'cache-control']
    )
    );

    if (!modulePath) {
      if (next) {
        next();
      } else {
        response.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
        });
        response.write('404: The requested resource could not be found.');
        response.end();
      }
    } else if (request.method != 'HEAD' && request.method != 'GET') {
      // I don't know how to do this.
      response.writeHead(405, {
        'allow': 'HEAD, GET',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.write('405: Only the HEAD or GET methods are allowed.');
      response.end();
    } else if (!('callback' in url.query)) {
      // I respond with a straight-forward proxy.
      const resourceURI = this._resourceURIForModulePath(modulePath);
      requestURI(resourceURI, 'GET', requestHeaders,
          (status, headers, content) => {
            const responseHeaders = selectProperties(headers, HEADER_WHITELIST);
            if (status == 200) {
              responseHeaders['content-type'] =
                'application/javascript; charset=utf-8';
            } else if (status == 404) {
              responseHeaders['content-type'] = 'text/plain; charset=utf-8';
              content = '404: The requested resource could not be found.';
            } else {
              if (notModified(requestHeaders, responseHeaders)) {
                status = 304;
              }
              // Don't bother giving useful stuff in these cases.
              delete responseHeaders['content-type'];
              content = undefined;
            }
            response.writeHead(status, responseHeaders);
            if (request.method == 'GET') {
              content && response.write(content);
            }
            response.end();
          }
      );
    } else {
      const JSONPCallback = url.query.callback;
      if (JSONPCallback.length == 0) {
        response.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
        });
        response.write('400: The parameter `callback` must be non-empty.');
        response.end();
        return;
      } else if (!JSONPCallback.match(JSONP_CALLBACK_EXPRESSION)) {
        response.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
        });
        response.write(`400: The parameter \`callback\` must match ${
          JSONP_CALLBACK_EXPRESSION}.`);
        response.end();
        return;
      }

      const respond = function (status, headers, content) {
        const responseHeaders = selectProperties(headers, HEADER_WHITELIST);
        responseHeaders['content-type'] =
            'application/javascript; charset=utf-8';
        // JSONP requires a guard against incorrect sniffing.
        responseHeaders['x-content-type-options'] = 'nosniff';

        if (status == 304 || notModified(requestHeaders, responseHeaders)) {
          response.writeHead(304, responseHeaders);
        } else {
          response.writeHead(200, responseHeaders);
          if (request.method == 'GET') {
            content && response.write(content);
          }
        }
        response.end();
      };

      let modulePaths = [modulePath];
      let preferredPath = modulePath;
      if (this._associator) {
        if (this._associator.preferredPath) {
          preferredPath = this._associator.preferredPath(preferredPath);
        }
        modulePaths = this._associator.associatedModulePaths(modulePath);
      }

      if (preferredPath != modulePath) {
        let location;
        if (preferredPath.charAt(0) == '/') {
          location = this._rootPath + preferredPath.slice(1);
        } else {
          location = this._libraryPath + preferredPath;
        }

        if (this._baseURI) { // Full URIs for location are opt-in.
          location = this._baseURI + location;
        } else {
          location = relativePath(
              location
              , path.split('/').join('/')
          );
        }
        location += `?${require('querystring').stringify(url.query)}`;

        // TODO: Caching headers?
        response.writeHead(307, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Location': location,
        });
        response.write('307: Resource moved temporarily.');
        response.end();
        return;
      }

      const self = this;
      const resourceURIs = modulePaths.map((modulePath) => self._resourceURIForModulePath(modulePath));

      // TODO: Uh, conditional GET?
      requestURIs(resourceURIs, 'HEAD', requestHeaders,
          function (statuss, headerss, contents) {
            const status = statuss.reduce((m, s) => m && m == s ? m : undefined);
            const headers = mergeHeaders.apply(this, headerss);
            if (status == 304 || notModified(requestHeaders, headers)) {
              respond(304, headers);
            } else if (request.method == 'HEAD' && status != 405) {
            // If HEAD wasn't implemented I must GET, else I can guarantee that
            // my response will not be a 304 and will be 200.
              respond(status, headers);
            } else {
            // HEAD was not helpful, so issue a GET and remove headers that
            // would yield a 304, we need full content for each resource.
              requestHeadersForGet = selectProperties(requestHeaders
                  , ['user-agent', 'accept', 'cache-control']);
              requestURIs(resourceURIs, 'GET', requestHeadersForGet,
                  function (statuss, headerss, contents) {
                    const status = statuss.reduce((m, s) => m && m == s ? m : undefined);
                    const headers = mergeHeaders.apply(this, headerss);
                    const moduleMap = {};
                    for (let i = 0, ii = contents.length; i < ii; i++) {
                      moduleMap[modulePaths[i]] =
                      statuss[i] == 200 ? contents[i] : null;
                    }
                    const content = packagedDefine(JSONPCallback, moduleMap);
                    if (request.method == 'HEAD') {
                      // I'll respond with no content
                      respond(status, headers);
                    } else if (request.method == 'GET') {
                      respond(status, headers, content);
                    }
                  }
              );
            }
          }
      );
    }
  }

  this._resourceURIForModulePath = _resourceURIForModulePath;
  this.setAssociator = setAssociator;
  this.handle = handle;
}();

exports.Server = Server;
