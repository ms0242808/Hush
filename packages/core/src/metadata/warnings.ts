// SPDX-License-Identifier: Apache-2.0

/**
 * Things the metadata step had to compromise on. None stops an export; each
 * is reported so the interface (and Copy diagnostics) can say what happened.
 *
 *   exif-unreadable          the EXIF block is malformed: copied untouched, or dropped when location had to go
 *   exif-thumbnail-dropped   the embedded thumbnail was removed to fit a JPEG's 64 KB EXIF segment
 *   exif-too-large           EXIF couldn't fit the output container at all and was left out
 *   icc-incomplete           a JPEG's colour profile was split across segments and some were missing
 *   colour-unknown           the source declared colours Hush can't describe in the output (no profile written)
 *   xmp-too-large            the XMP packet didn't fit a JPEG segment and was left out
 *   xmp-extended-dropped     extended XMP was removed because it held location data
 *   iptc-not-carried         IPTC captions exist only in JPEG; another output format can't hold them
 *   bit-depth-reduced        the source had more than 8 bits per channel; Hush saves 8 bits this phase
 */
export type MetadataWarning =
	| 'exif-unreadable'
	| 'exif-thumbnail-dropped'
	| 'exif-too-large'
	| 'icc-incomplete'
	| 'colour-unknown'
	| 'xmp-too-large'
	| 'xmp-extended-dropped'
	| 'iptc-not-carried'
	| 'bit-depth-reduced';
