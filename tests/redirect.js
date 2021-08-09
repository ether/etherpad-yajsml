'use strict';

const {Server, associators: {StaticAssociator}} = require('../index.js');
const assert = require('assert').strict;
const express = require('express');
const supertest = require('supertest');

describe(__filename, function () {
  let agent;

  const testCases = [
    {from: 'a', to: 'a', want: null},
    {from: 'a', to: 'b', want: 'b'},
    {from: 'a', to: 'a/', want: 'a/'},
    {from: 'a/', to: 'a', want: '../a'},
    {from: 'a', to: 'a/b', want: 'a/b'},
    {from: 'a/b', to: 'a', want: '../a'},
    {from: 'a/', to: 'a/b', want: 'b'},
    {from: 'a/b', to: 'a/', want: './'},
    {from: '', to: 'b', want: 'b'},
  ];

  before(async function () {
    const app = express();
    agent = supertest(app);
    const server = new Server({
      // libraryURI must be set, but it can be anything because requestURIs ignores the URL.
      libraryURI: 'http://ignored.because.of.requestURIs.example',
      // Bypass request code. This avoids the need to set up an Express route and get the URL of the
      // temporary HTTP server.
      requestURIs: (locations, method, headers, cb) => cb(
          Array(locations.length).fill(200),
          Array(locations.length).fill({}),
          Array(locations.length).fill("'use strict';")),
    });
    const preferred =
        Object.fromEntries(testCases.map(({from, to}, i) => [`${i}/${from}`, `${i}/${to}`]));
    server.setAssociator(new StaticAssociator([{}, preferred]));
    app.use(server.handle.bind(server));
  });

  const str = JSON.stringify;

  testCases.forEach(({from, to, want}, i) => {
    it(`from ${str(from)} to ${str(to)} is ${str(want)}`, async function () {
      if (want != null) {
        // Make sure our assumptions are correct:
        const fromUrl = new URL(from, 'http://localhost/');
        const toUrl = new URL(to, 'http://localhost/');
        assert.equal(new URL(want, fromUrl).href, toUrl.href);
      }
      const path = `/library/${i}/${from}?callback=require.define`;
      if (want == null) {
        await agent.get(path)
            .expect(200);
      } else {
        await agent.get(path)
            .expect(307)
            .expect('Location', `${want}?callback=require.define`);
      }
    });
  });
});
