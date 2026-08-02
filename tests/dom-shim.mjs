/**
 * The cleaning code is written against browser APIs. Node has
 * CompressionStream and crypto.subtle but no DOM, so tests and the CLI install
 * an XML implementation under the same global names.
 */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

if (typeof globalThis.DOMParser === 'undefined') {
  globalThis.DOMParser = DOMParser
  globalThis.XMLSerializer = XMLSerializer
}
