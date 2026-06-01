import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { PolyglottKernel } from './kernel';
// import { LanguageSupport } from '@codemirror/language';
/**
 * A plugin to register the echo kernel.
 */
const kernel: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/echo-kernel:kernel',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterFrontEnd, kernelspecs: IKernelSpecs) => {
    kernelspecs.register({
      spec: {
        name: 'polyglott',
        display_name: 'Polyglott Kernel',
        language: 'text',
        argv: [],
        resources: {
          'logo-32x32': '',
          'logo-64x64': ''
        }
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        return new PolyglottKernel(options, kernelspecs);
      }
    });
  }
};

// import { languages } from "@codemirror/language-data";


import {
    codemirrorPolyglottExtension,makeAutolang
} from './codemirror_ext';

// import {EditorView, ViewPlugin, ViewUpdate} from "@codemirror/view"
// import {LanguageSupport} from "@codemirror/language"

import {javascript} from "@codemirror/lang-javascript"
// import {python} from "@codemirror/lang-python"
// import {html} from "@codemirror/lang-html"
import {LanguageSupport} from "@codemirror/language";

import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';
import { Compartment } from "@codemirror/state"



// adding the extension via addLanguage does not work :/

// const language_plugin: JupyterFrontEndPlugin<void> = {
//   id: '@jupyterlab-examples/codemirror-extension:plugin',
//   description: 'A minimal JupyterLab extension registering the Polyglott language mapping.',
//   autoStart: true,
//   requires: [IEditorLanguageRegistry], // 👈 Request the language registry token instead
//   activate: (app: JupyterFrontEnd, languages: IEditorLanguageRegistry) => {
//     // // Register the Polyglott mode spec into the global CodeMirror registry
//     // // ... inside your activate function ...
//     languages.addLanguage({
//       name: 'polyglott',
//       // Register all MIME types your kernel info bundle might emit
//       mime: ['text/x-polyglott', 'application/x-polyglott'],
//       load: async () => {
//         const languageConf = new Compartment();
//         // dummy language
//         const base = javascript();
//         return new LanguageSupport(
//           base.language,
//           [
//             languageConf.of(base),
//             makeAutolang(languageConf)
//           ]
//         );
//       }
//     });
//   }
// };

// IEditorExtensionRegistry
import { IEditorExtensionRegistry,EditorExtensionRegistry } from '@jupyterlab/codemirror';

const editor_plugin: JupyterFrontEndPlugin<void> = {
    id: '@jupyterlab-examples/codemirror-extension:plugin',
    description: 'A minimal JupyterLab extension adding a CodeMirror extension.',
    autoStart: true,
    requires: [IEditorExtensionRegistry],
    activate: (app: JupyterFrontEnd, extensions: IEditorExtensionRegistry) => {
       
    
        // Register a new editor configurable extension
        extensions.addExtension(
            Object.freeze({
                name: '@jupyterlab-examples/codemirror:polyglott-extension',

                factory: (options: any) =>
                EditorExtensionRegistry.createConfigurableExtension(() => {
                    const languageConf = new Compartment();
                    return [codemirrorPolyglottExtension(languageConf)];
                }),
            })
        );
    }
};



const plugins: JupyterFrontEndPlugin<any>[] = [kernel, editor_plugin];

export default plugins;
