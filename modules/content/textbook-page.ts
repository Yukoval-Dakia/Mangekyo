export {
  assetBodyReference as textbookBodyReference,
  checkTextbookBasis, checkTextbookTree, locateTextbookBlock, mergeTextbookBasis, openTextbookBlock,
  openAssetReference as openTextbookReference,
  parseTextbookBasis, parseTextbookBlockBody, parseTextbookPage, parseTextbookReference, requireTextbookBodyBasis,
  textbookPageFrom, textbookPageType,
  verifyAssetBlockReference as verifyTextbookBodyReference,
  type TextbookAnchor, type TextbookBasis, type TextbookBlock, type TextbookBlockBody, type TextbookPage,
  type TextbookReadContext, type TextbookReference,
} from './asset.ts';
