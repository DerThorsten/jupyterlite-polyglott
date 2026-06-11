import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { PolyglottKernel } from './kernel';

import logo32 from '../style/logo-32x32.png';
import logo64 from '../style/logo-64x64.png';

// import { LanguageSupport } from '@codemirror/language';
/**
 * A plugin to register the echo kernel.
 */
const kernel: JupyterFrontEndPlugin<void> = {
  id: '@derthorsten/jupyterlite-polyglott:kernel',
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
          'logo-32x32': logo32,
          'logo-64x64': logo64
        }
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        return new PolyglottKernel(options, kernelspecs);
      }
    });
  }
};
import { Compartment } from '@codemirror/state';
import { codemirrorPolyglottExtension } from './codemirror_ext';

import {
  IEditorExtensionRegistry,
  EditorExtensionRegistry
} from '@jupyterlab/codemirror';

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
          })
      })
    );
  }
};

const plugins: JupyterFrontEndPlugin<any>[] = [kernel, editor_plugin];

export default plugins;
