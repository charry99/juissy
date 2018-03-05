import Filter from './filters.js';

export default class DrupalClient {

  constructor(baseUrl, {logger = console, authorization = null} = {}) {
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.authorization = authorization;
    this.links = new Promise((resolve, reject) => {
      this.fetchDocument(`${baseUrl}/jsonapi`)
        .then(doc => resolve(doc.links || {}))
        .catch(err => {
          this.logger.log('Unable to resolve resource links.');
          reject(err);
        });
    });
  }

  async get(type, id) {
    const link = `${await this.getLink(type)}/${id}`;
    return this.documentData(await this.fetchDocument(link));
  }

  async all(type, { limit = -1, sort = '', filter = '', relationships = null} = {}) {
    let link = await this.collectionLink(type, {sort, filter, page: 'page[limit]=50'});
    let expanded = this.expandRelationships(relationships);
    return this.paginate(link, limit, expanded);
  }

  expandRelationships(relationships) {
    const expander = (node) => {
      return typeof node === 'string'
        ? {field: node}
        : node;
    };
    const objectMapper = (node, mapper, initial) => {
      return Object.getOwnPropertyNames(node).reduce((mapped, prop) => {
        mapped[prop] = mapper(node[prop]);
        if (node[prop].relationships) {
          mapped[prop].relationships = objectMapper(node[prop].relationships, mapper, {})
        }
        return mapped;
      }, {});
    };
    return objectMapper(relationships, expander, {});
  }

  paginate(link, limit, relationships) {
    var buffer = [];
    var total = 0;
    const inFlight = new Set([]);

    const doRequest = nextLink => {
      inFlight.add(nextLink);
      return this.fetchDocument(nextLink).then(doc => {
        inFlight.delete(nextLink);
        link = doc.links.next || false;
        const data = this.documentData(doc);
        const resources = Array.isArray(data) ? data : [data];
        total += (resources) ? resources.length : 0;
        buffer.push(...(resources || []));
        return Promise.resolve(buffer);
      });
    };

    var collectionRequests = [];
    const advance = () => {
      if (link && !inFlight.has(link) && (limit === -1 || total < limit)) {
        collectionRequests.push(doRequest(link));
      }
      return !buffer.length && collectionRequests.length
        ? collectionRequests.shift().then(() => buffer)
        : Promise.resolve(buffer);
    };

    let count = 0;
    const cursor = (function*() {
      while (buffer.length || inFlight.size || link) {
        yield limit === -1 || count < limit ? advance().then(buffer => {
          count++;
          const resource = buffer.shift();
          return resource || null;
        }) : false;
      }
    })();
    cursor.canContinue = () => buffer.length || inFlight.size || link;
    cursor.addMore = (many = -1) => many === -1 ? (limit = -1) : (limit += many);

    if (link && !inFlight.has(link) && (limit === -1 || total < limit)) {
      collectionRequests.push(doRequest(link));
    }

    return this.toConsumer(cursor, relationships);
  }

  toConsumer(cursor, relationships = null) {
    const self = this;
    return {
      consume: function(consumer, preserveOrder = false) {
        const queue = [];
        const queuedConsumer = (resource, relationships) => {
          queue.push(preserveOrder
            ? () => {
              return relationships ? consumer(resource, relationships) : consumer(resource);
            }
            : relationships ? consumer(resource, relationships) : consumer(resource));
        }
        const decoratedConsumer = self.decorateWithRelationships(queuedConsumer, relationships);
        const filteringConsumer = resource => {
          return (resource) ? decoratedConsumer(resource) : null;
        };
        return new Promise((resolve, reject) => {
          const f = next => {
            if (next) {
              // @note: using async/await for this 'then' caused browser crashes.
              next.then(resource => {
                filteringConsumer(resource);
                f(cursor.next().value);
              }).catch(reject);
            } else {
              if (preserveOrder) {
                Promise.all(queue).then(() => {
                  resolve(cursor.canContinue() ? cursor.addMore : false);
                });
              }
              else {
                resolve(cursor.canContinue() ? cursor.addMore : false);
              }
            }
          };
          f(cursor.next().value);
        }).then(next => {
          return new Promise(async (resolve, reject) => {
            if (preserveOrder) {
              while (queue.length) {
                let fn = queue.shift();
                let ret = fn();
                if (ret instanceof Promise) {
                  await ret.catch(reject);
                }
              }
            }
            resolve(next);
          });
        });
      },
    };
  }

  debugger() {
    return (error) => {
      // @todo: this should actually check for errors.jsonapi
      if (error.errors) {
        const logError = error => {
          this.logger.info(`${error.title}: ${error.detail}. %s`, error.links.info);
        }
        error.errors.forEach(logError);
      }
      else {
        //this.logger.log(error);
      }
    }
  }

  decorateWithRelationships(consumer, relationships = null) {
    const decorated = !relationships
      ? consumer
      : resource => {
        const mirror = {};
        Object.getOwnPropertyNames(relationships).forEach(relationship => {
          const target = relationships[relationship];
          let path = [], link;
          mirror[relationship] = (link = extractValue(`relationships.${target.field}.links.related`, resource))
            ? this.paginate(link, target.limit || -1, target.relationships || null)
            : Promise.reject();
        });
        return consumer(resource, mirror);
      };
    return decorated;
  }

  fetchDocument(url) {
    const options = this.authorization ? {headers: new Headers({authorization: this.authorization})} : {};
    return fetch(url, options).then(res => {
      if (res.ok) {
        return res.json();
      }
      else {
        reject(res.statusText);
        //return new Promise(async (resolve, reject) => {
        //  //let doc = await res.json().catch(() => reject(res.statusText));
        //  reject(doc);
        //});
      }
    });
  }

  documentData(doc) {
    if (doc.hasOwnProperty('data')) {
      return doc.data;
    }
    if (doc.hasOwnProperty('errors')) {
      throw new Error(doc);
    } else {
      throw new Error('The server returned an unprocessable document with no data or errors.');
    }
  }

  getLink(type) {
    return this.links.then(links => {
      if (!links.hasOwnProperty(type)) {
        Promise.reject(`'${type}' is not a valid type for ${this.baseUrl}.`);
      }
      return links[type];
    });
  }

  filter(f) {
    return new Filter(f);
  }

  async collectionLink(type, {sort, filter, page} = {}) {
    let query = '';
    query += filter.length ? `?${filter}` : '';
    query += sort.length ? `${query.length ? '&' : '?'}sort=${sort}` : '';
    query += page.length ? `${query.length ? '&' : '?'}${page}` : '';
    return `${await this.getLink(type)}${query}`;
  }

}

function extractValue(path, obj) {
  return path.split('.').reduce((exists, part) => exists && exists.hasOwnProperty(part) ? exists[part] : false, obj);
}
