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
const associationsForSimpleMapping = (mapping) => {
  const bundleToModules = {};
  const moduleToBundle = {};
  for (const [bundle, modules] of Object.entries(mapping)) {
    if (hasOwnProperty(bundleToModules, bundle)) {
      throw new Error(`bundle ${JSON.stringify(bundle)} already defined`);
    }
    bundleToModules[bundle] = [...modules];
    for (const module of modules) {
      if (!hasOwnProperty(mapping, module) || module === bundle) {
        moduleToBundle[module] = bundle;
      }
    }
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

exports.StaticAssociator = StaticAssociator;
exports.IdentityAssociator = IdentityAssociator;
exports.SimpleAssociator = SimpleAssociator;

exports.associationsForSimpleMapping = associationsForSimpleMapping;
exports.complexMappingForAssociations = complexMappingForAssociations;
exports.associationsForComplexMapping = associationsForComplexMapping;
