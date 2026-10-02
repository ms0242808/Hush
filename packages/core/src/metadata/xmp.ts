// SPDX-License-Identifier: Apache-2.0
import { latin1, latin1String } from '../bytes.ts';
import type { Bytes } from '../types.ts';

/**
 * XMP is XML. Location lives in properties whose local name starts with
 * "GPS" — exif:GPSLatitude, exif:GPSLongitude and friends, and the GPS fields
 * inside Iptc4xmpExt:LocationCreated/LocationShown — written either as
 * attributes or as elements. Removing them is a text edit, done on the raw
 * bytes as Latin-1 so multi-byte UTF-8 elsewhere passes through untouched
 * (every character the patterns match is ASCII).
 */
const NAME = '[A-Za-z_][\\w.-]*:GPS[\\w.-]*';
const GPS_ATTRIBUTE = new RegExp(`\\s${NAME}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g');
const GPS_EMPTY_ELEMENT = new RegExp(`<(${NAME})\\b[^>]*/>`, 'g');
const GPS_ELEMENT = new RegExp(`<(${NAME})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'g');
const ANY_GPS = new RegExp(`${NAME}`);

export function xmpHasLocation(xmp: Bytes): boolean {
	return ANY_GPS.test(latin1String(xmp));
}

/** XMP with every GPS property removed. Returns the input itself when there was nothing to remove. */
export function stripXmpLocation(xmp: Bytes): Bytes {
	const text = latin1String(xmp);
	if (!ANY_GPS.test(text)) return xmp;
	const stripped = text.replace(GPS_ELEMENT, '').replace(GPS_EMPTY_ELEMENT, '').replace(GPS_ATTRIBUTE, '');
	return latin1(stripped);
}
