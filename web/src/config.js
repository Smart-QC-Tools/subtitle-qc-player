// Version of Subtitle QC Player (shown in Help; the Mac app and the download page use it too).
const APP_VERSION = '1.0.0';

/* ==========================================================================
   REFERENCE LANGUAGE LIST  (edit here)
   Source: DETE_Language_Code.xlsx. Each entry: [name, code].
   Codes are compared case-insensitively (zh-hans == zh-Hans).
   ========================================================================== */
const REFERENCE_LIST = [
  ['AFRIKAANS','af'], ['ALBANIAN','sq'], ['ARABIC','ar'], ['ARMENIAN','hy'], ['AZERBAIJANI','az'],
  ['BAHASA_INDONESIAN','id'], ['BAHASA_MALAY','ms'], ['BASQUE','eu'], ['BOSNIAN','bs'], ['BULGARIAN','bg'],
  ['BURMESE','my'], ['CHINESE_CANTONESE','yue'], ['CHINESE_MANDARIN_MNLAND','zh-hans'],
  ['CHINESE_MANDARIN_SINGAPORE','zh-SG'], ['CHINESE_MANDARIN_TAIWAN','zh-hant'], ['CHINESE_VERIFY_DIALECT','zh'],
  ['CROATIAN','hr'], ['CZECH','cs'], ['DANISH','da'], ['DARI','prs'], ['DUTCH','nl'], ['ENGLISH','en'],
  ['ESTONIAN','et'], ['FARSI_IRANIAN','fa'], ['FINNISH','fi'], ['FLEMISH','nl'], ['FLEMISH_DUTCH','nl'],
  ['FLEMISH_FRENCH','nl'], ['FRENCH_CANADIAN','fr-CA'], ['FRENCH_PARISIAN','fr-FR'], ['FRENCH_VERIFY_DIALECT','fr'],
  ['GAELIC_IRELAND','ga'], ['GEORGIAN','ka'], ['GERMAN','de'], ['GREEK','el'], ['HEBREW','he'], ['HINDI','hi'],
  ['HUNGARIAN','hu'], ['ICELANDIC','is'], ['ITALIAN','it'], ['JAPANESE','ja'], ['KANNADA','kn'], ['KHMER','km'],
  ['KOREAN','ko'], ['LATVIAN','lv'], ['LITHUANIAN','lt'], ['MACEDONIAN','mk'], ['MALAYALAM','ml'],
  ['MONGOLIAN','mn'], ['NORWEGIAN','no'], ['PASHTO','ps'], ['POLISH','pl'], ['PORTUGUESE_BRAZIL','pt-BR'],
  ['PORTUGUESE_PORTUGAL','pt-PT'], ['PORTUGUESE_VERIFY','pt'], ['ROMANIAN','ro'], ['RUSSIAN','ru'],
  ['SERBIAN','sr'], ['SLOVAK','sk'], ['SLOVENIAN','sl'], ['SPANISH_ARGENTINEAN','es-AR'],
  ['SPANISH_CASTILLIAN','es-ES'], ['SPANISH_CATALAN','ca'], ['SPANISH_CHILEAN','es-CL'],
  ['SPANISH_COLOMBIAN','es-CO'], ['SPANISH_LATIN','es-419'], ['SPANISH_MEXICAN','es-MX'],
  ['SPANISH_PERUVIAN','es-PE'], ['SPANISH_VERIFY_DIALECT','es'], ['SWEDISH','sv'], ['TAGALOG','tl'],
  ['TAMIL_INDIA','ta'], ['TELUGU_INDIA','te'], ['THAI','th'], ['TURKISH','tr'], ['UKRANIAN','uk'],
  ['URDU_PAKISTAN','ur'], ['VIETNAMESE','vi'], ['WELSH','cy'], ['YU_SERBIAN','sr']
];

/* Codes that mean the same language as a list code but are written differently
   (ISO 639-2/3, deprecated codes, Apple-style cmn/yue tags). A label using one of
   these is flagged as a warning ("non-standard code"), not an error. */
const BASE_ALIASES = {
  eng:'en', spa:'es', fre:'fr', fra:'fr', ger:'de', deu:'de', ita:'it', por:'pt', jpn:'ja', kor:'ko',
  rus:'ru', ara:'ar', heb:'he', iw:'he', hin:'hi', tha:'th', vie:'vi', tur:'tr', pol:'pl', ces:'cs', cze:'cs',
  slk:'sk', slo:'sk', hun:'hu', ron:'ro', rum:'ro', mo:'ro', bul:'bg', hrv:'hr', srp:'sr', bos:'bs', slv:'sl',
  ell:'el', gre:'el', nld:'nl', dut:'nl', dan:'da', swe:'sv', nor:'no', nob:'no', nb:'no', nno:'no', nn:'no',
  fin:'fi', est:'et', lav:'lv', lit:'lt', isl:'is', ice:'is', gle:'ga', cym:'cy', wel:'cy', eus:'eu', baq:'eu',
  cat:'ca', sqi:'sq', alb:'sq', hye:'hy', arm:'hy', kat:'ka', geo:'ka', aze:'az', ind:'id', in:'id',
  msa:'ms', may:'ms', tgl:'tl', fil:'tl', mya:'my', bur:'my', khm:'km', kan:'kn', mal:'ml', tam:'ta',
  tel:'te', urd:'ur', pus:'ps', fas:'fa', per:'fa', mon:'mn', mkd:'mk', mac:'mk', ukr:'uk', afr:'af',
  zho:'zh', chi:'zh', cmn:'zh', fa_af:'prs'
};
const REGION_ALIASES = { la:'419', lat:'419', latam:'419', cast:'ES' };
/* zh region -> implied script */
const ZH_REGION_SCRIPT = { CN:'Hans', SG:'Hans', MY:'Hans', TW:'Hant', HK:'Hant', MO:'Hant' };

/* Language words that may appear in file names (lower case). DETE names are added automatically. */
const FILENAME_WORDS = {
  english:'en', spanish:'es', espanol:'es', 'español':'es', castilian:'es-ES', castellano:'es-ES',
  latam:'es-419', latinoamericano:'es-419', latino:'es-419', mexican:'es-MX', french:'fr', francais:'fr',
  'français':'fr', parisian:'fr-FR', quebec:'fr-CA', quebecois:'fr-CA', 'québécois':'fr-CA', german:'de',
  deutsch:'de', italian:'it', italiano:'it', portuguese:'pt', portugues:'pt', 'português':'pt',
  brazilian:'pt-BR', brasil:'pt-BR', brazil:'pt-BR', japanese:'ja', korean:'ko', chinese:'zh', mandarin:'zh',
  simplified:'zh-Hans', traditional:'zh-Hant', cantonese:'yue', russian:'ru', arabic:'ar', hebrew:'he',
  dutch:'nl', flemish:'nl', polish:'pl', czech:'cs', greek:'el', turkish:'tr', thai:'th', vietnamese:'vi',
  indonesian:'id', malay:'ms', hindi:'hi', tamil:'ta', telugu:'te', kannada:'kn', malayalam:'ml',
  swedish:'sv', danish:'da', norwegian:'no', finnish:'fi', hungarian:'hu', romanian:'ro', bulgarian:'bg',
  croatian:'hr', serbian:'sr', slovenian:'sl', slovak:'sk', ukrainian:'uk', ukranian:'uk', catalan:'ca',
  icelandic:'is', estonian:'et', latvian:'lv', lithuanian:'lt', albanian:'sq', armenian:'hy',
  azerbaijani:'az', basque:'eu', bosnian:'bs', burmese:'my', dari:'prs', farsi:'fa', persian:'fa',
  irish:'ga', gaelic:'ga', georgian:'ka', khmer:'km', macedonian:'mk', mongolian:'mn', pashto:'ps',
  tagalog:'tl', filipino:'tl', urdu:'ur', welsh:'cy', afrikaans:'af'
};
/* Compact codes seen in file names without a separator. */
// Three-letter codes used by dubbing / subtitling vendors. strong = distinctive enough to trust anywhere.
const VENDOR_LANG_CODES = Object.fromEntries(Object.entries({
  'es-ES': ['csp:1', 'cas', 'spe:1', 'esp'], 'es-419': ['lsp:1', 'las', 'lat', 'lam:1', 'spl:1'], 'es-MX': ['esm:1', 'mxs:1'],
  'pt-BR': ['bpt:1', 'ptb:1', 'brp:1', 'pob:1', 'bpo:1'], 'pt-PT': ['ept:1', 'ptp:1', 'ppt', 'epo:1', 'ptg:1'],
  'ja': ['jap:1'], 'ro': ['rom'], 'gl': ['glg:1'], 'yue': ['can'],
  'fr-CA': ['cfr:1', 'frc:1', 'fca:1'], 'fr-FR': ['pfr:1', 'frp:1'],
  'zh-Hans': ['zhs:1', 'sch:1', 'cmn'], 'zh-Hant': ['zht:1', 'tch:1'], 'nl-BE': ['fle:1', 'vls:1'],
}).flatMap(([code, list]) => list.map(x => { const [k, st] = x.split(':'); return [k, { code, strong: !!st }]; })));
const FILENAME_COMPACT = {
  ptbr:'pt-BR', ptpt:'pt-PT', esla:'es-419', eslat:'es-419', eslatam:'es-419', es419:'es-419', eses:'es-ES',
  esmx:'es-MX', frca:'fr-CA', frfr:'fr-FR', enus:'en-US', engb:'en-GB', zhcn:'zh-Hans', zhtw:'zh-Hant',
  zhhk:'zh-Hant', zhhans:'zh-Hans', zhhant:'zh-Hant', chs:'zh-Hans', cht:'zh-Hant'
};

// How list names are shown: regional variants read the way people say them ("Brazilian Portuguese").
const NAME_DISPLAY = {
  PORTUGUESE_BRAZIL: 'Brazilian Portuguese', PORTUGUESE_PORTUGAL: 'European Portuguese',
  SPANISH_LATIN: 'Latin Spanish', SPANISH_CASTILLIAN: 'Castilian Spanish', SPANISH_MEXICAN: 'Mexican Spanish',
  SPANISH_ARGENTINEAN: 'Argentinean Spanish', SPANISH_CHILEAN: 'Chilean Spanish', SPANISH_COLOMBIAN: 'Colombian Spanish',
  SPANISH_PERUVIAN: 'Peruvian Spanish', SPANISH_CATALAN: 'Catalan',
  FRENCH_CANADIAN: 'Canadian French', FRENCH_PARISIAN: 'Parisian French', FLEMISH_DUTCH: 'Flemish',
  CHINESE_MANDARIN_MNLAND: 'Mainland Mandarin', CHINESE_MANDARIN_TAIWAN: 'Taiwanese Mandarin',
  CHINESE_MANDARIN_SINGAPORE: 'Singaporean Mandarin', CHINESE_CANTONESE: 'Cantonese',
  FARSI_IRANIAN: 'Iranian Farsi', GAELIC_IRELAND: 'Irish Gaelic', BAHASA_INDONESIAN: 'Indonesian', BAHASA_MALAY: 'Malay',
  TAMIL_INDIA: 'Tamil', TELUGU_INDIA: 'Telugu', URDU_PAKISTAN: 'Urdu', YU_SERBIAN: 'Serbian', UKRANIAN: 'Ukrainian',
};
