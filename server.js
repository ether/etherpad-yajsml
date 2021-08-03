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

const path = require('path');
const {requestURI, requestURIs} = require('./request');

const HEADER_WHITELIST =
    ['date', 'last-modified', 'expires', 'cache-control', 'content-type'];

const hasOwnProperty = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const relativePath = (from, to) => {
  const fromSplit = from.split('/');
  // Remove the last component from `from`. This is necessary because web URLs don't behave like
  // filesystem directories: the relative path from '/a/b' to /a/b/c' is 'b/c', not 'c' ('/a/b' is
  // always considered to be a file named 'b' inside directory '/a').
  fromSplit.pop();
  const toSplit = to.split('/');
  // Similarly, make sure `to` is always treated as a file (unless it ends with '/'), not a
  // directory: the relative path from '/a/b/c' to '/a/b' is '../b', not '.', './', or ''.
  const toFile = toSplit.pop();
  while (fromSplit.length !== 0 && fromSplit[0] === toSplit[0]) {
    fromSplit.shift();
    toSplit.shift();
  }
  toSplit.push(toFile);
  const relative = '../'.repeat(fromSplit.length) + toSplit.join('/');
  // Corner case: If `from` is '/a/b' and `to` is '/a/', then `relative` will be the empty string.
  // Applying '' to '/a/b' does not result in '/a/', so return './' if `relative` is empty.
  return relative || './';
};

const normalizePath = path.posix.normalize;

// OSWASP Guidlines: escape all non alphanumeric characters in ASCII space.
const escapeNonAlphanumerics = (text, exceptions) => text && text.replace(
    /[^0-9A-Za-z]/g,
    (c) => exceptions && exceptions.includes(c)
      ? c
      : `\\u${(`000${c.charCodeAt(0).toString(16)}`).slice(-4)}`);

// Only allow a subset of JavaScript expressions that are reasonable and cannot
// look like HTML (e.g. `require.define`, `requireForKey("key").define`).
const JSONP_CALLBACK_EXPRESSION = /^[a-zA-Z0-9$:._'"\\()[\]{}]+$/;

const selectProperties = (o, keys) => {
  const object = {};
  for (const key of keys) {
    if (hasOwnProperty(o, key)) {
      object[key] = o[key];
    }
  }
  return object;
};

const validateURI = (uri) => {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:') {
    throw new Error(`Invalid URI: ${JSON.stringify(uri)}.`);
  }
};

// Request HEAD for the given resources and return the composition of all
// responses. Each response is merged in a way preserves the repeatability and
// meaning of the aggregate. If any response can not be merged cleanly the
// result will be `undefined`.
const mergeHeaders = (...headersList) => {
  const headers = {};

  let values, value;
  values = headersList.map((h) => Date.parse(h.date));
  if (values.every((value) => !isNaN(value))) {
    value = Math.max(...values);
    headers.date = (new Date(value)).toUTCString();
  }

  values = headersList.map((h) => Date.parse(h['last-modified']));
  if (values.every((value) => !isNaN(value))) {
    value = Math.max(...values);
    headers['last-modified'] = (new Date(value)).toUTCString();
  }

  values = headersList.map((h) => Date.parse(h.expires));
  if (values.every((value) => !isNaN(value))) {
    value = Math.min(...values);
    headers.expires = (new Date(value)).toUTCString();
  }

  values = headersList.map((h) => {
    const expires = (h['cache-control'] || '').match(/(?:max-age=(\d+))?/)[1];
    return parseInt(expires, 10);
  });
  if (values.every((value) => !isNaN(value))) {
    value = Math.min(...values);
    headers['cache-control'] = `max-age=${value.toString(10)}`;
  }

  return headers;
};

const packagedDefine = (JSONPCallback, moduleMap) => {
  let content = `${JSONPCallback}({`;
  for (const [path, body] of Object.entries(moduleMap)) {
    const pathEsc = escapeNonAlphanumerics(path, './-_');
    content += `"${pathEsc}": `;
    if (body === null) { // eslint-disable-line eqeqeq
      content += 'null';
    } else {
      // Improve the readability of stack traces by naming the function that defines the module
      // "(module the/module/path.js)". This is accomplished by taking advantage of an ES6
      // feature: When an anonymous function expression is assigned to a variable or an object
      // property, the function's `.name` property is set to the variable name or object property
      // name. For example, the following expression would evaluate to a no-op function whose name
      // is the value of the variable `x`:
      //     {[x]: () => {}}[x]
      //
      // If we did nothing special and simply appended the module definition function expression
      // to `content`, the function would have a name that equals the value of `path` because the
      // function is assigned to an object property whose name is the value of `path`. That's
      // mostly good enough, with one limitation: When displaying a stack trace in the developer
      // console, Firefox (as of v90) does some mysterious processing that sometimes chops off the
      // first part of the function's `.name` property. The logic seems arbitrary -- it's not
      // simply keeping "good" characters. For example, "foo bar.js" is printed in its entirety,
      // but "foobar.js" becomes "js". Introducing a space seems to cause Firefox to reliably
      // print the entire name. (The `Error.stack` property does not suffer from this problem --
      // the complete name is always included.)
      const nl = `"(module ${pathEsc})"`; // Name literal.
      // Note: This is a regular function, not an arrow function, so that the require kernel can
      // set the context (`this` inside the module) to `module.exports` to match Node.js's
      // behavior.
      content += `{${nl}: function (require, exports, module) {${body}}}[${nl}]`;
    }
    content += ',\n';
  }
  content += '});\n';

  return content;
};

const notModified = (requestHeaders, responseHeaders) => {
  const lastModified = Date.parse(responseHeaders['last-modified']);
  const modifiedSince = Date.parse(requestHeaders['if-modified-since']);
  return ((requestHeaders.etag && requestHeaders.etag === responseHeaders.etag) ||
      (lastModified && lastModified <= modifiedSince));
};

/*
 * I implement a JavaScript module server.
 */
class Server {
  constructor(options) {
    const trailingSlash = (path) => path && !path.endsWith('/') ? `${path}/` : path;
    const leadingSlash = (path) => path && !path.startsWith('/') ? `/${path}` : path;

    if (options.rootURI) {
      this._rootURI = trailingSlash(options.rootURI);
      validateURI(this._rootURI);
      const {rootPath = 'root'} = options;
      this._rootPath = leadingSlash(trailingSlash(rootPath));
    }

    if (options.libraryURI) {
      this._libraryURI = trailingSlash(options.libraryURI);
      validateURI(this._libraryURI);
      const {libraryPath = 'library'} = options;
      this._libraryPath = leadingSlash(trailingSlash(libraryPath));
    }

    if (this._rootPath && this._libraryPath &&
        (this._rootPath.indexOf(this._libraryPath) === 0 ||
         this._libraryPath.indexOf(this._rootPath) === 0)) {
      throw new Error(`The paths ${JSON.stringify(this._rootPath)} and ` +
                      `${JSON.stringify(this._libraryPath)} are ambiguous.`);
    }

    if (options.baseURI) {
      this._baseURI = trailingSlash(options.baseURI);
    }

    // Some clients insist on transforming values, but cannot run transformation
    // on a separate service. This enables a workaround #hack.
    this._requestURIs = async (...args) => await new Promise((resolve) => {
      (options.requestURIs || requestURIs)(...args, (...vals) => resolve(vals));
    });
  }

  _resourceURIForModulePath(path) {
    return path.startsWith('/') ? this._rootURI + path.slice(1) : this._libraryURI + path;
  }

  setAssociator(associator) {
    this._associator = associator;
  }

  handle(request, response, next) {
    (async () => {
      let url;
      try {
        url = new URL(request.url, 'ignored-scheme:/');
      } catch (e) {
        response.writeHead(422, {'content-type': 'text/plain; charset=utf-8'});
        response.write('422: Malformed URL');
        response.end();
        return;
      }
      const path = normalizePath(url.pathname);

      let modulePath;
      if (path.indexOf(this._rootPath) === 0) {
        modulePath = `/${path.slice(this._rootPath.length)}`;
      } else if (this._libraryURI && path.indexOf(this._libraryPath) === 0) {
        modulePath = path.slice(this._libraryPath.length);
      } else {
        // Something has gone wrong.
      }

      const requestHeaders = Object.assign({
        'user-agent': 'yajsml',
        'accept': '*/*',
      }, selectProperties(request.headers, ['if-modified-since', 'cache-control']));

      if (!modulePath) {
        if (next) {
          next();
        } else {
          response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
          response.write('404: The requested resource could not be found.');
          response.end();
        }
      } else if (request.method !== 'HEAD' && request.method !== 'GET') {
        // I don't know how to do this.
        response.writeHead(405, {
          'allow': 'HEAD, GET',
          'content-type': 'text/plain; charset=utf-8',
        });
        response.write('405: Only the HEAD or GET methods are allowed.');
        response.end();
      } else if (!url.searchParams.has('callback')) {
        // I respond with a straight-forward proxy.
        const resourceURI = this._resourceURIForModulePath(modulePath);
        let [status, headers, content] = await new Promise((resolve) => {
          requestURI(resourceURI, 'GET', requestHeaders, (...vals) => resolve(vals));
        });
        headers = selectProperties(headers, HEADER_WHITELIST);
        if (status === 200) {
          headers['content-type'] = 'application/javascript; charset=utf-8';
        } else if (status === 404) {
          headers['content-type'] = 'text/plain; charset=utf-8';
          content = '404: The requested resource could not be found.';
        } else {
          if (notModified(requestHeaders, headers)) status = 304;
          // Don't bother giving useful stuff in these cases.
          delete headers['content-type'];
          content = undefined;
        }
        response.writeHead(status, headers);
        if (request.method === 'GET' && content) response.write(content);
        response.end();
      } else {
        const JSONPCallback = url.searchParams.get('callback');
        if (JSONPCallback.length === 0) {
          response.writeHead(400, {'content-type': 'text/plain; charset=utf-8'});
          response.write("400: The 'callback' parameter must be non-empty.");
          response.end();
          return;
        } else if (!JSONPCallback.match(JSONP_CALLBACK_EXPRESSION)) {
          response.writeHead(400, {'content-type': 'text/plain; charset=utf-8'});
          response.write(`400: The 'callback' parameter must match ${JSONP_CALLBACK_EXPRESSION}.`);
          response.end();
          return;
        }

        const preferredPath = this._associator && this._associator.preferredPath
          ? this._associator.preferredPath(modulePath)
          : modulePath;

        if (preferredPath !== modulePath) {
          let location;
          if (preferredPath.charAt(0) === '/') {
            location = this._rootPath + preferredPath.slice(1);
          } else {
            location = this._libraryPath + preferredPath;
          }

          if (this._baseURI) { // Full URIs for location are opt-in.
            location = this._baseURI + location;
          } else {
            location = relativePath(path, location);
          }
          location += url.search;

          // TODO: Caching headers?
          response.writeHead(307, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Location': location,
          });
          response.write('307: Resource moved temporarily.');
          response.end();
          return;
        }

        const modulePaths = this._associator
          ? this._associator.associatedModulePaths(modulePath)
          : [modulePath];
        const resourceURIs = modulePaths.map((m) => this._resourceURIForModulePath(m));

        // TODO: Uh, conditional GET?
        const [statuss, headerss] = await this._requestURIs(resourceURIs, 'HEAD', requestHeaders);
        let status = statuss.reduce((m, s) => m && m === s ? m : undefined);
        let headers = mergeHeaders(...headerss);
        let content = null;
        if (status === 304 || notModified(requestHeaders, headers)) {
          status = 304;
        } else if (request.method === 'HEAD' && status !== 405) {
          // If HEAD wasn't implemented I must GET, else I can guarantee that
          // my response will not be a 304 and will be 200.
        } else {
          // HEAD was not helpful, so issue a GET and remove headers that
          // would yield a 304, we need full content for each resource.
          const requestHeadersForGet =
              selectProperties(requestHeaders, ['user-agent', 'accept', 'cache-control']);
          const [statuss, headerss, contents] =
              await this._requestURIs(resourceURIs, 'GET', requestHeadersForGet);
          status = statuss.reduce((m, s) => m && m === s ? m : undefined);
          headers = mergeHeaders(...headerss);
          if (request.method === 'HEAD') {
            // I'll respond with no content
          } else if (request.method === 'GET') {
            const moduleMap = Object.fromEntries(
                modulePaths.map((m, i) => [m, statuss[i] === 200 ? contents[i] : null]));
            content = packagedDefine(JSONPCallback, moduleMap);
          } else {
            return;
          }
        }

        headers = selectProperties(headers, HEADER_WHITELIST);
        headers['content-type'] = 'application/javascript; charset=utf-8';
        // JSONP requires a guard against incorrect sniffing.
        headers['x-content-type-options'] = 'nosniff';

        status = status === 304 || notModified(requestHeaders, headers) ? 304 : 200;
        response.writeHead(status, headers);
        if (content) response.write(content);
        response.end();
      }
    })().catch((err) => next(err || new Error(err)));
  }
}

exports.Server = Server;
