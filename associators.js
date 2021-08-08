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

const util = require('util');

// An Alias defines an alternative name that can be passed to `require()` instead of the alias
// target. This is useful for defining a "main" module of a package, and to allow users to omit
// `.js` or `/index.js` suffixes.
//
// For example:
//     new Alias('jquery', 'jquery/dist/jquery.min.js')
// creates an alias that causes:
//     require('jquery')
// to be equivalent to:
//     require('jquery/dist/jquery.min.js')
// The alias is served to the require kernel in a bundle definition that looks like:
//     require.define({
//       'jquery': 'jquery/dist/jquery.min.js',
//       'jquery/dist/jquery.min.js': function (require, exports, module) { /* module body */ },
//     });
class Alias {
  constructor(alias, target) {
    this.alias = alias;
    this.target = target;
  }
  [util.inspect.custom](depth, opts) {
    opts = {...opts, depth: opts.depth == null ? null : opts.depth - 1};
    return `${util.inspect(this.alias, opts)} -> ${util.inspect(this.target, opts)}`;
  }
}

const hasOwnProperty = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/*
 * Produce fully structured module mapings from a simple description.
 *
 * INPUT:
 * { '/module/path/1.js':
 *   [ '/module/path/1.js'
 *   , '/module/path/2.js'
 *   , '/module/path/3.js'
 *   , '/module/path/4.js'
 *   ]
 * , '/module/path/4.js':
 *   [ '/module/path/3.js'
 *   , '/module/path/4.js'
 *   , '/module/path/5.js'
 *   , new Alias('/module', '/module/path/3.js')
 *   ]
 * }
 *
 * OUTPUT:
 * [ { '/module/path/1.js':
 *     [ '/module/path/1.js'
 *     , '/module/path/2.js'
 *     , '/module/path/3.js'
 *     , '/module/path/4.js'
 *     ]
 *   , '/module/path/4.js':
 *     [ '/module/path/3.js'
 *     , '/module/path/4.js'
 *     , '/module/path/5.js'
 *     , new Alias('/module', '/module/path/3.js')
 *     ]
 *   }
 * , { '/module/path/1.js': '/module/path/1.js'
 *   , '/module/path/2.js': '/module/path/1.js'
 *   , '/module/path/3.js': '/module/path/4.js'
 *   , '/module/path/4.js': '/module/path/4.js'
 *   , '/module/path/5.js': '/module/path/4.js'
 *   , '/module': '/module/path/4.js'
 *   }
 * ]
 */
const associationsForSimpleMapping = (mapping) => {
  const bundleToModules = {};
  const moduleToBundle = {};
  const indirections = new Map();
  for (const [bundle, modules] of Object.entries(mapping)) {
    if (hasOwnProperty(bundleToModules, bundle)) {
      throw new Error(`bundle ${JSON.stringify(bundle)} already defined`);
    }
    bundleToModules[bundle] = [...modules];
    for (const module of modules) {
      const moduleName = module instanceof Alias ? module.alias : module;
      const targetName = module instanceof Alias ? module.target : null;
      if (indirections.has(moduleName) && indirections.get(moduleName) !== targetName) {
        throw new Error(`conflicting definition of module ${moduleName}`);
      }
      indirections.set(moduleName, targetName);
      if (module instanceof Alias) continue;
      if (!hasOwnProperty(mapping, moduleName) || moduleName === bundle) {
        moduleToBundle[moduleName] = bundle;
      }
    }
  }
  for (const [moduleName, target] of indirections) {
    const seen = new Set([moduleName]);
    let [real, next] = [moduleName, target];
    while (next != null) {
      if (seen.has(next)) throw new Error(`alias loop while resolving ${moduleName}`);
      seen.add(next);
      [real, next] = [next, indirections.get(next)];
    }
    moduleToBundle[moduleName] = hasOwnProperty(moduleToBundle, real) ? moduleToBundle[real] : real;
  }
  return [bundleToModules, moduleToBundle];
};


/*
 * Inverse of `associationsForComplexMapping`.
 *
 * INPUT:
 * [ { '/module/path/1.js':
 *     [ '/module/path/1.js'
 *     , '/module/path/2.js'
 *     , '/module/path/3.js'
 *     , '/module/path/4.js'
 *     ]
 *   , '/module/path/4.js':
 *     [ '/module/path/3.js'
 *     , '/module/path/4.js'
 *     , '/module/path/5.js'
 *     ]
 *   }
 * , { '/module/path/1.js': '/module/path/1.js'
 *   , '/module/path/2.js': '/module/path/1.js'
 *   , '/module/path/3.js': '/module/path/4.js'
 *   , '/module/path/4.js': '/module/path/4.js'
 *   , '/module/path/5.js': '/module/path/4.js'
 *   }
 * ]
 *
 * OUTPUT:
 * [ [ '/module/path/1.js'
 *   , '/module/path/4.js'
 *   ]
 * , { '/module/path/1.js': [0, [true, false]]
 *   , '/module/path/2.js': [0, [true, false]]
 *   , '/module/path/3.js': [1, [true, true]]
 *   , '/module/path/4.js': [1, [true, true]]
 *   , '/module/path/5.js': [1, [false, true]]
 *   }
 * ]
 */
const complexMappingForAssociations = (associations) => {
  const packageModuleMap = associations[0];

  const packages = Object.keys(packageModuleMap);
  const mapping = {};

  const blankMapping = packages.map(() => false);
  packages.forEach((pkg, i) => {
    for (const key of packageModuleMap[pkg]) {
      if (!hasOwnProperty(mapping, key)) mapping[key] = [i, [...blankMapping]];
      mapping[key][0] = i;
      mapping[key][1][i] = true;
    }
  });

  return [packages, mapping];
};

/*
 * Produce fully structured module mapings from association description.
 *
 * INPUT:
 * [ [ '/module/path/1.js'
 *   , '/module/path/4.js'
 *   ]
 * , { '/module/path/1.js': [0, [true, false]]
 *   , '/module/path/2.js': [0, [true, false]]
 *   , '/module/path/3.js': [1, [true, true]]
 *   , '/module/path/4.js': [1, [true, true]]
 *   , '/module/path/5.js': [1, [false, true]]
 *   }
 * ]
 *
 * OUTPUT:
 * [ { '/module/path/1.js':
 *     [ '/module/path/1.js'
 *     , '/module/path/2.js'
 *     , '/module/path/3.js'
 *     , '/module/path/4.js'
 *     ]
 *   , '/module/path/4.js':
 *     [ '/module/path/3.js'
 *     , '/module/path/4.js'
 *     , '/module/path/5.js'
 *     ]
 *   }
 * , { '/module/path/1.js': '/module/path/1.js'
 *   , '/module/path/2.js': '/module/path/1.js'
 *   , '/module/path/3.js': '/module/path/4.js'
 *   , '/module/path/4.js': '/module/path/4.js'
 *   , '/module/path/5.js': '/module/path/4.js'
 *   }
 * ]
 */
const associationsForComplexMapping = (packages, associations) => {
  const packageSet = {};
  packages.forEach((pkg, i) => {
    if (pkg === undefined) {
      // BAD: Package has no purpose.
    } else if (hasOwnProperty(packageSet, pkg)) {
      // BAD: Duplicate package.
    } else if (!hasOwnProperty(associations, pkg)) {
      // BAD: Package primary doesn't exist for this package
    } else if (associations[pkg][0] !== i) {
      // BAD: Package primary doesn't agree
    }
    packageSet[pkg] = true;
  });

  const packageModuleMap = {};
  const modulePackageMap = {};
  for (const [path, association] of Object.entries(associations)) {
    modulePackageMap[path] = packages[association[0]];
    association[1].forEach((include, i) => {
      if (include) {
        const pkg = packages[i];
        if (!hasOwnProperty(packageModuleMap, pkg)) {
          packageModuleMap[pkg] = [];
        }
        packageModuleMap[pkg].push(path);
      }
    });
  }

  return [packageModuleMap, modulePackageMap];
};

/*
 * I determine which modules are associated with one another for a JS module
 * server.
 *
 * INPUT:
 * [ { '/module/path/1.js':
 *     [ '/module/path/1.js'
 *     , '/module/path/2.js'
 *     , '/module/path/3.js'
 *     , '/module/path/4.js'
 *     ]
 *   , '/module/path/4.js':
 *     [ '/module/path/3.js'
 *     , '/module/path/4.js'
 *     , '/module/path/5.js'
 *     ]
 *   }
 * , { '/module/path/1.js': '/module/path/1.js'
 *   , '/module/path/2.js': '/module/path/1.js'
 *   , '/module/path/3.js': '/module/path/4.js'
 *   , '/module/path/4.js': '/module/path/4.js'
 *   , '/module/path/5.js': '/module/path/4.js'
 *   }
 * ]
 */
class StaticAssociator {
  constructor(associations, next) {
    this._packageModuleMap = associations[0];
    this._modulePackageMap = associations[1];
    this._next = next || new IdentityAssociator();
  }
  preferredPath(modulePath) {
    if (hasOwnProperty(this._modulePackageMap, modulePath)) {
      return this._modulePackageMap[modulePath];
    } else {
      return this._next.preferredPath(modulePath);
    }
  }
  associatedModulePaths(modulePath) {
    modulePath = this.preferredPath(modulePath);
    if (hasOwnProperty(this._packageModuleMap, modulePath)) {
      return this._packageModuleMap[modulePath];
    } else {
      return this._next.associatedModulePaths(modulePath);
    }
  }
}

class IdentityAssociator {
  preferredPath(modulePath) {
    return modulePath;
  }
  associatedModulePaths(modulePath) {
    return [modulePath];
  }
}

class SimpleAssociator {
  preferredPath(modulePath) {
    return this.associatedModulePaths(modulePath)[0];
  }
  associatedModulePaths(modulePath) {
    modulePath = modulePath.replace(/\.js$|(?:^|\/)index\.js$|.\/+$/, '');
    return [modulePath, `${modulePath}.js`, `${modulePath}/index.js`];
  }
}

exports.Alias = Alias;
exports.StaticAssociator = StaticAssociator;
exports.IdentityAssociator = IdentityAssociator;
exports.SimpleAssociator = SimpleAssociator;

exports.associationsForSimpleMapping = associationsForSimpleMapping;
exports.complexMappingForAssociations = complexMappingForAssociations;
exports.associationsForComplexMapping = associationsForComplexMapping;
