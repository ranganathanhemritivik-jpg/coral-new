// Local test storage. MongoDB remains available when mongoUri is configured.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
function get(object, key) {
  return key.split('.').reduce((value, part) => value == null ? undefined : value[part], object);
}
function set(object, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  for (const part of parts) object = object[part] ??= {};
  object[last] = value;
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function condition(value, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    for (const [operator, operand] of Object.entries(expected)) {
      const values = Array.isArray(value) ? value : [value];
      if (operator === '$in' && !values.some(v => operand.some(x => equal(v, x)))) return false;
      if (operator === '$nin' && values.some(v => operand.some(x => equal(v, x)))) return false;
      if (operator === '$exists' && (value !== undefined) !== operand) return false;
      if (operator === '$gt' && !(value > operand)) return false;
      if (operator === '$gte' && !(value >= operand)) return false;
      if (operator === '$lte' && !(value <= operand)) return false;
      if (operator === '$regex' && !new RegExp(operand, expected.$options || '').test(String(value ?? ''))) return false;
      if (!operator.startsWith('$') && !condition(value?.[operator], operand)) return false;
      if (operator.startsWith('$') && !['$in','$nin','$exists','$gt','$gte','$lte','$regex','$options'].includes(operator)) throw new Error('Unsupported query: ' + operator);
    }
    return true;
  }
  return Array.isArray(value) ? value.some(v => equal(v, expected)) : equal(value, expected);
}
function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const parts = key.split('.');
    let values = [document];
    for (const part of parts) values = values.flatMap(value => Array.isArray(value) ? value.map(v => v?.[part]) : [value?.[part]]);
    return values.some(value => condition(value, expected));
  });
}
class Cursor {
  constructor(rows) { this.rows = rows; }
  sort(order) {
    this.rows.sort((a,b) => {
      for (const [key, direction] of Object.entries(order)) {
        const av = get(a,key), bv = get(b,key);
        if (av !== bv) return (av > bv ? 1 : -1) * direction;
      }
      return 0;
    });
    return this;
  }
  skip(n) { this.rows = this.rows.slice(Math.max(0,n)); return this; }
  limit(n) { this.rows = this.rows.slice(0,Math.max(0,n)); return this; }
  project(fields) {
    const include = Object.entries(fields).filter(([,v]) => v === 1).map(([k]) => k);
    this.rows = this.rows.map(row => {
      if (include.length) {
        const result = {};
        if (row._id && fields._id !== 0) result._id = row._id;
        for (const key of include) if (get(row,key) !== undefined) set(result,key,get(row,key));
        return result;
      }
      const result = clone(row);
      for (const [key,value] of Object.entries(fields)) if (value === 0) delete result[key];
      return result;
    });
    return this;
  }
  async toArray() { return clone(this.rows); }
}
class Collection {
  constructor(db,name) { this.db = db; this.name = name; this.unique = []; }
  rows() { return this.db.prepare('SELECT document FROM documents WHERE collection = ?').all(this.name).map(r => JSON.parse(r.document)); }
  async createIndex(keys,options = {}) { if (options.unique) this.unique.push({keys:Object.keys(keys),sparse:options.sparse}); }
  async createIndexes(indexes) { for (const index of indexes) await this.createIndex(index.key,index); }
  find(query = {}) { return new Cursor(this.rows().filter(row => matches(row,query))); }
  async findOne(query = {}) { return this.rows().find(row => matches(row,query)) ?? null; }
  aggregate(pipeline) {
    let cursor = new Cursor(this.rows());
    for (const stage of pipeline) {
      if (stage.$match) cursor.rows = cursor.rows.filter(row => matches(row,stage.$match));
      else if (stage.$project) cursor.project(stage.$project);
      else if (stage.$sample) {
        for (let i=cursor.rows.length-1;i>0;i--) { const j=crypto.randomInt(i+1); [cursor.rows[i],cursor.rows[j]]=[cursor.rows[j],cursor.rows[i]]; }
        cursor.limit(stage.$sample.size);
      } else throw new Error('Unsupported aggregation stage');
    }
    return cursor;
  }
  checkUnique(document,ignoreId) {
    for (const index of this.unique) {
      if (index.sparse && index.keys.some(k => get(document,k) === undefined)) continue;
      if (this.rows().some(row => row._id !== ignoreId && index.keys.every(k => equal(get(row,k),get(document,k))))) {
        const error = new Error('Duplicate account field'); error.code = 11000; throw error;
      }
    }
  }
  async insertOne(document) {
    const row = clone(document); row._id ??= crypto.randomBytes(12).toString('hex');
    this.checkUnique(row);
    this.db.prepare('INSERT INTO documents(collection,id,document) VALUES (?,?,?)').run(this.name,row._id,JSON.stringify(row));
    return {insertedId:row._id};
  }
  async deleteMany(query = {}) {
    const rows = this.rows().filter(row => matches(row,query));
    for (const row of rows) this.db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?').run(this.name,row._id);
    return {deletedCount:rows.length};
  }
  async deleteOne(query) {
    const row = await this.findOne(query); if (!row) return {deletedCount:0};
    this.db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?').run(this.name,row._id);
    return {deletedCount:1};
  }
  async updateOne(query,updates,options = {}) {
    let row = await this.findOne(query);
    if (!row) {
      if (!options.upsert) return {matchedCount:0,modifiedCount:0};
      const result = await this.insertOne({...query,...updates.$set});
      return {matchedCount:0,modifiedCount:0,upsertedId:result.insertedId};
    }
    for (const [operator,fields] of Object.entries(updates)) {
      for (let [key,value] of Object.entries(fields)) {
        if (key.includes('.$.')) {
          const [arrayName,field] = key.split('.$.');
          const criteria = Object.fromEntries(Object.entries(query).filter(([k]) => k.startsWith(arrayName+'.')).map(([k,v]) => [k.slice(arrayName.length+1),v]));
          const index = get(row,arrayName).findIndex(item => matches(item,criteria));
          if (index < 0) throw new Error('No matching array entry');
          key = arrayName+'.'+index+'.'+field;
        }
        if (operator === '$set') set(row,key,value);
        else if (operator === '$inc') set(row,key,(get(row,key) || 0)+value);
        else if (operator === '$push' || operator === '$addToSet') {
          const array = get(row,key) || []; const values = value?.$each || [value];
          for (const item of values) if (operator === '$push' || !array.some(v => equal(v,item))) array.push(item);
          set(row,key,array);
        } else if (operator === '$pull') set(row,key,(get(row,key) || []).filter(item => !condition(item,value)));
        else throw new Error('Unsupported update: ' + operator);
      }
    }
    this.checkUnique(row,row._id);
    this.db.prepare('UPDATE documents SET document = ? WHERE collection = ? AND id = ?').run(JSON.stringify(row),this.name,row._id);
    return {matchedCount:1,modifiedCount:1};
  }
}
class LocalDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(collection,id));');
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name,new Collection(this.db,name));
    return this.collections.get(name);
  }
}
module.exports = {LocalDatabase};
