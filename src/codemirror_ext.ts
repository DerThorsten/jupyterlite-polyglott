import { EditorState, Compartment } from '@codemirror/state';
import { Extension } from '@codemirror/state';
import { languages } from '@codemirror/language-data';
import { kernelInfos } from './kernel';

import { LanguageDescription } from '@codemirror/language';

// map from kernel name / language name to CodeMirror language extension
const languageExtensions: Map<string, Extension> = new Map();

// for some languages we want to preload the CodeMirror language support
// st we can highlight the cell right away without having to wait
// for the user to execute the cell
const commonLanguages = [
  'python',
  'c',
  'c++',
  'lua',
  'javascript',
  'r',
  'fortran',
  'lua'
];

const aliasToExtensionKey: { [key: string]: string } = {
  xpython: 'python',
  xr: 'r',
  xlua: 'lua',
  xcpp23: 'c++',
  xcpp17: 'c++',
  xcpp11: 'c++',
  xc23: 'c',
  xc17: 'c',
  xc11: 'c'
};

async function getStorageExtension(
  modeString: string
): Promise<Extension | null> {
  // 1. Search for the language by name, alias, or filename extension
  const languageDesc = languages.find(
    lang =>
      lang.name.toLowerCase() === modeString.toLowerCase() ||
      lang.alias.some(alias => alias.toLowerCase() === modeString.toLowerCase())
  );
  if (languageDesc) {
    return await languageDesc.load();
  }

  const languageDescAlt = LanguageDescription.matchLanguageName(
    languages,
    modeString
  );
  if (languageDescAlt) {
    return await languageDescAlt.load();
  }

  return null;
}

async function preloadCommonLanguages() {
  for (const lang of commonLanguages) {
    console.log(`Preloading CodeMirror language support for ${lang}...`);
    const ext = await getStorageExtension(lang);
    if (ext) {
      console.log(
        `setting ${ext} for language ${lang} in ${languageExtensions}`
      );
      languageExtensions.set(lang, ext);
    }
  }
  for (const kernelName in aliasToExtensionKey) {
    const lang = aliasToExtensionKey[kernelName];
    languageExtensions.set(kernelName, languageExtensions.get(lang)!);
  }
}

// fire the preloading in the background
preloadCommonLanguages();

function extractNameFromCodemirrorMode(codemirrorMode: any): string | null {
  if (typeof codemirrorMode === 'string') {
    return codemirrorMode;
  } else if (typeof codemirrorMode === 'object' && codemirrorMode.name) {
    return codemirrorMode.name;
  }
  return null;
}

// helper function to get the appropriate CodeMirror language extension for a given kernel name
function getLanguageExtension(kernelName: string): Extension | null {
  const spec = kernelInfos[kernelName];

  // try directly with the kernel name, as some kernels might not provide a proper language_info
  if (languageExtensions.has(kernelName)) {
    return languageExtensions.get(kernelName)!;
  }

  if (spec && spec.language_info) {
    const language = spec.language_info.name;
    const mimetype = spec.language_info.mimetype;
    const codemirrorMode = spec.language_info.codemirror_mode;
    if (codemirrorMode) {
      const mode = extractNameFromCodemirrorMode(codemirrorMode);

      if (mode && languageExtensions.has(mode)) {
        return languageExtensions.get(mode)!;
      }
    }
    if (mimetype && languageExtensions.has(mimetype)) {
      const ext = languageExtensions.get(mimetype);
      if (ext) {
        return ext;
      }
    }
    if (language && languageExtensions.has(language.toLowerCase())) {
      const ext = languageExtensions.get(language.toLowerCase());
      if (ext) {
        return ext;
      }
    }
  }

  return null;
}

export function makeAutolang(languageConf: Compartment) {
  const autoLanguage = EditorState.transactionExtender.of(tr => {
    // get the first line
    const firstLine = tr.newDoc.line(1).text;
    // check if it starts with %%kernel <KERNEL_NAME>
    const match = firstLine.match(/^\s*%%kernel\s+(\w+)/);
    if (!match) {
      return null;
    }
    const kernelName = match[1];

    const langExt = getLanguageExtension(kernelName); // this gives us an Extension like  {python} from "@codemirror/lang-python"
    if (!langExt) {
      console.warn(`No language extension found for kernel ${kernelName}`);
      return {
        effects: languageConf.reconfigure([])
      };
    }

    return {
      effects: languageConf.reconfigure(langExt)
    };
  });
  return autoLanguage;
}

// Full extension composed of elemental extensions
export function codemirrorPolyglottExtension(
  languageConf: Compartment
): Extension {
  const autoLanguage = EditorState.transactionExtender.of(tr => {
    // get the first line
    const firstLine = tr.newDoc.line(1).text;
    // check if it starts with %%kernel <KERNEL_NAME>
    const match = firstLine.match(/^\s*%%kernel\s+(\w+)/);
    if (!match) {
      return null;
    }
    const kernelName = match[1];

    const langExt = getLanguageExtension(kernelName); // this gives us an Extension like  {python} from "@codemirror/lang-python"
    if (!langExt) {
      console.warn(`No language extension found for kernel ${kernelName}`);
      return {
        effects: languageConf.reconfigure([])
      };
    }

    return {
      effects: languageConf.reconfigure(langExt)
    };
  });

  return [
    languageConf.of([]), // start with no language extension
    autoLanguage
  ];
}
