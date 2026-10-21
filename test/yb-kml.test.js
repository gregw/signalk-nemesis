'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseYbKml} = require('./sim/yb-kml');

const KML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:kml xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:ns2="http://www.opengis.net/kml/2.2">
  <ns2:Document>
    <ns2:Style id="style0"><ns2:IconStyle><ns2:scale>1.0</ns2:scale></ns2:IconStyle></ns2:Style>
    <ns2:Folder>
      <ns2:name>Tracks</ns2:name>
      <ns2:Placemark>
        <ns2:name>Wot&apos;s Next</ns2:name>
        <ns2:styleUrl>#style0</ns2:styleUrl>
        <gx:Track>
          <gx:altitudeMode>clampToGround</gx:altitudeMode>
          <ns2:when>2026-10-16T06:10:00Z</ns2:when>
          <ns2:when>2026-10-16T06:00:30Z</ns2:when>
          <gx:coord>151.29,-33.85,4</gx:coord>
          <gx:coord>151.28000000000002,-33.84,2</gx:coord>
        </gx:Track>
      </ns2:Placemark>
      <ns2:Placemark>
        <ns2:name>Spare 3</ns2:name>
        <gx:Track><gx:altitudeMode>clampToGround</gx:altitudeMode></gx:Track>
      </ns2:Placemark>
    </ns2:Folder>
  </ns2:Document>
</ns2:kml>`;

test('YB KML: each unit its name and fixes [t, lat, lon] sorted by time, coord order lon,lat', () => {
    const units = parseYbKml(KML);
    assert.deepEqual(
        units.map((u) => u.name),
        ["Wot's Next", 'Spare 3']
    );
    assert.deepEqual(units[0].samples, [
        [Date.parse('2026-10-16T06:00:30Z'), -33.84, 151.28000000000002],
        [Date.parse('2026-10-16T06:10:00Z'), -33.85, 151.29]
    ]);
    assert.deepEqual(units[1].samples, [], 'a unit with no fixes');
});
