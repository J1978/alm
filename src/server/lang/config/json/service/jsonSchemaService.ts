/**
 * From : https://raw.githubusercontent.com/Microsoft/vscode/master/extensions/json/server/src/jsonSchemaService.ts
 *
 * The original has a lot of code (around XHRs and looking up schemas mainly) that we do not need
 *
 * We simply need the `JSONSchemaService.resolveSchemaContent`
 * - And the class `ResolvedSchema` (not sure I need this yet, but good container for errors)
 */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Json = require('../jsonc');
import {IJSONSchema, IJSONSchemaMap} from '../jsonSchema';
import URI from '../utils/uri';
import Strings = require('../utils/strings');
import Parser = require('../jsonParser');
import {localize} from "../localize";
type Thenable<T> = Promise<T>;

/**
 * Copied straight out of JSONSchemaService
 * Resolves *links* in schema definitions
 * NOTE: Mutates the argument `schema` too!
 */
export function resolveSchemaContent(schema: IJSONSchema): Thenable<ResolvedSchema> {

    let resolveErrors: string[] = [];

    let findSection = (schema: IJSONSchema, path: string): any => {
        if (!path) {
            return schema;
        }
        let current: any = schema;
        path.substr(1).split('/').some((part) => {
            current = current[part];
            return !current;
        });
        return current;
    };

    let resolveLink = (node: any, linkedSchema: IJSONSchema, linkPath: string): void => {
        let section = findSection(linkedSchema, linkPath);
        if (section) {
            for (let key in section) {
                if (section.hasOwnProperty(key) && !node.hasOwnProperty(key)) {
                    node[key] = section[key];
                }
            }
        } else {
            resolveErrors.push(localize('json.schema.invalidref', '$ref \'{0}\' in {1} can not be resolved.', linkPath, linkedSchema.id));
        }
        delete node.$ref;
    };

    let resolveExternalLink = (node: any, uri: string, linkPath: string): Thenable<any> => {
        return this.getOrAddSchemaHandle(uri).getUnresolvedSchema().then(unresolvedSchema => {
            if (unresolvedSchema.errors.length) {
                let loc = linkPath ? uri + '#' + linkPath : uri;
                resolveErrors.push(localize('json.schema.problemloadingref', 'Problems loading reference \'{0}\': {1}', loc, unresolvedSchema.errors[0]));
            }
            resolveLink(node, unresolvedSchema.schema, linkPath);
            return resolveRefs(node, unresolvedSchema.schema);
        });
    };

    let resolveRefs = (node: IJSONSchema, parentSchema: IJSONSchema): Thenable<any> => {
        let toWalk : IJSONSchema[] = [node];
        let seen: IJSONSchema[] = [];

        let openPromises: Thenable<any>[] = [];

        let collectEntries = (...entries: IJSONSchema[]) => {
            for (let entry of entries) {
                if (typeof entry === 'object') {
                    toWalk.push(entry);
                }
            }
        };
        let collectMapEntries = (...maps: IJSONSchemaMap[]) => {
            for (let map of maps) {
                if (typeof map === 'object') {
                    for (let key in map) {
                        let entry = map[key];
                        toWalk.push(entry);
                    }
                }
            }
        };
        let collectArrayEntries = (...arrays: IJSONSchema[][]) => {
            for (let array of arrays) {
                if (Array.isArray(array)) {
                    toWalk.push.apply(toWalk, array);
                }
            }
        };
        while (toWalk.length) {
            let next = toWalk.pop();
            if (seen.indexOf(next) >= 0) {
                continue;
            }
            seen.push(next);
            if (next.$ref) {
                let segments = next.$ref.split('#', 2);
                if (segments[0].length > 0) {
                    openPromises.push(resolveExternalLink(next, segments[0], segments[1]));
                    continue;
                } else {
                    resolveLink(next, parentSchema, segments[1]);
                }
            }
            collectEntries(next.items, next.additionalProperties, next.not);
            collectMapEntries(next.definitions, next.properties, next.patternProperties, <IJSONSchemaMap> next.dependencies);
            collectArrayEntries(next.anyOf, next.allOf, next.oneOf, <IJSONSchema[]> next.items);
        }
        return Promise.all(openPromises);
    };

    return resolveRefs(schema, schema).then(_ => new ResolvedSchema(schema, resolveErrors));
}

export class ResolvedSchema {
	public schema: IJSONSchema;
	public errors: string[];

	constructor(schema: IJSONSchema, errors: string[] = []) {
		this.schema = schema;
		this.errors = errors;
	}

	public getSection(path: string[]): IJSONSchema {
		return this.getSectionRecursive(path, this.schema);
	}

	private getSectionRecursive(path: string[], schema: IJSONSchema): IJSONSchema {
		if (!schema || path.length === 0) {
			return schema;
		}
		let next = path.shift();

		if (schema.properties && schema.properties[next]) {
			return this.getSectionRecursive(path, schema.properties[next]);
		} else if (schema.patternProperties) {
			Object.keys(schema.patternProperties).forEach((pattern) => {
				let regex = new RegExp(pattern);
				if (regex.test(next)) {
					return this.getSectionRecursive(path, schema.patternProperties[pattern]);
				}
			});
		} else if (schema.additionalProperties) {
			return this.getSectionRecursive(path, schema.additionalProperties);
		} else if (next.match('[0-9]+')) {
			if (schema.items) {
				return this.getSectionRecursive(path, schema.items);
			} else if (Array.isArray(schema.items)) {
				try {
					let index = parseInt(next, 10);
					if (schema.items[index]) {
						return this.getSectionRecursive(path, schema.items[index]);
					}
					return null;
				}
				catch (e) {
					return null;
				}
			}
		}

		return null;
	}
}
