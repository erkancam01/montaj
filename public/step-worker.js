/* eslint-disable */
// Klasik Web Worker: occt-import-js ile STEP/IGES/BREP dosyalarını üçgen ağlara çevirir.
// Mesaj: { id, format: 'step'|'iges'|'brep', buffer: ArrayBuffer }
// Yanıt: { id, ok: true, result } | { id, ok: false, error }
importScripts('occt-import-js.js');

var occtPromise = null;

function getOcct() {
  if (!occtPromise) {
    occtPromise = occtimportjs({
      locateFile: function (p) {
        return p;
      },
    });
    occtPromise.catch(function () {
      occtPromise = null;
    });
  }
  return occtPromise;
}

var PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

function toF32(a) {
  if (!a) return null;
  return a instanceof Float32Array ? a : new Float32Array(a);
}

function toU32(a) {
  if (!a) return null;
  return a instanceof Uint32Array ? a : new Uint32Array(a);
}

function errorText(e) {
  if (!e) return 'Bilinmeyen hata';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try {
    return String(e);
  } catch (_) {
    return 'Bilinmeyen hata';
  }
}

onmessage = async function (ev) {
  var data = ev.data || {};
  var id = data.id;
  try {
    var occt = await getOcct();
    var raw = occt.ReadFile(data.format, new Uint8Array(data.buffer), PARAMS);
    if (!raw || !raw.success) {
      postMessage({ id: id, ok: false, error: 'Dosya okunamadı (geçersiz ya da desteklenmeyen içerik).' });
      return;
    }
    var transfer = [];
    var meshes = (raw.meshes || []).map(function (m) {
      var attrs = m.attributes || {};
      var position = toF32(attrs.position && attrs.position.array);
      var normal = toF32(attrs.normal && attrs.normal.array);
      var index = toU32(m.index && m.index.array);
      if (position) transfer.push(position.buffer);
      if (normal) transfer.push(normal.buffer);
      if (index) transfer.push(index.buffer);
      return {
        name: m.name || '',
        color: m.color || null,
        brep_faces: (m.brep_faces || []).map(function (f) {
          return { first: f.first, last: f.last, color: f.color || null };
        }),
        position: position || new Float32Array(0),
        normal: normal,
        index: index,
      };
    });
    postMessage({ id: id, ok: true, result: { root: raw.root, meshes: meshes } }, transfer);
  } catch (e) {
    postMessage({ id: id, ok: false, error: errorText(e) });
  }
};
