// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';

import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

export class PolyglottKernel implements IKernel {
  constructor(options: IKernel.IOptions, kernelspecs: IKernelSpecs) {
    this.kernelSpecs = kernelspecs;
    console.log('Creating kernel with options', options);
    const { id, name, location, sendMessage } = options;
    this._id = id;
    this._name = name;
    this._location = location;
    this._sendMessage = sendMessage;
  }

  /**
   * Get the kernel id
   */
  get id(): string {
    return this._id;
  }

  /**
   * Get the name of the kernel
   */
  get name(): string {
    return this._name;
  }

  /**
   * The location in the virtual filesystem from which the kernel was started.
   */
  get location(): string {
    return this._location;
  }

  get ready(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Return whether the kernel is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A signal emitted when the kernel is disposed.
   */
  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._disposed.emit(void 0);
  }
  /**
   * Send an `error` message to the client.
   *
   * @param parentHeader The parent header.
   * @param content The error content.
   */
  protected publishExecuteError(
    content: KernelMessage.IErrorMsg['content'],
    parentHeader:
      | KernelMessage.IHeader<KernelMessage.MessageType>
      | undefined = undefined
  ): void {
    const parentHeaderValue = parentHeader ?? this._parentHeader;
    const message = KernelMessage.createMessage<KernelMessage.IErrorMsg>({
      channel: 'iopub',
      msgType: 'error',
      // TODO: better handle this
      session: parentHeaderValue?.session ?? '',
      parentHeader: parentHeaderValue,
      content
    });
    this._sendMessage(message);
  }

  /**
   * Send an 'idle' status message.
   *
   * @param parent The parent message
   */
  private _idle(parent: KernelMessage.IMessage): void {
    const message = KernelMessage.createMessage<KernelMessage.IStatusMsg>({
      msgType: 'status',
      session: parent.header.session,
      parentHeader: parent.header,
      channel: 'iopub',
      content: {
        execution_state: 'idle'
      }
    });
    this._sendMessage(message);
  }

  /**
   * Send a 'busy' status message.
   *
   * @param parent The parent message.
   */
  private _busy(parent: KernelMessage.IMessage): void {
    const message = KernelMessage.createMessage<KernelMessage.IStatusMsg>({
      msgType: 'status',
      session: parent.header.session,
      parentHeader: parent.header,
      channel: 'iopub',
      content: {
        execution_state: 'busy'
      }
    });
    this._sendMessage(message);
  }

  // each kernel gets a sendMessage function that it can use to send messages back to the server.
  // this method is given to the "sub-kernels" to send messages back to the server.
  // we intercept these messages here and then forward them to the server, but we could also do some processing here if needed.
  private _sendMessageDispatch(
    msg: KernelMessage.IMessage,
    kernelName: string
  ): void {
    console.log(`Kernel ${kernelName} sending message`, msg);

    // const content = msg.content as any;
    // if(content && content.name === 'stdout' && content.text === 'Kernel successfuly started!\n') {
    //     console.log('Skipping first message from kernel', kernelName);
    //     return;
    // }

    this._sendMessage(msg);
  }

  // helper to get the kernel from name
  protected async getKernelByName(
    kernelName: string
  ): Promise<IKernel | undefined> {
    if (!this.startedKernels.has(kernelName)) {
      if (!this.kernelSpecs.factories.has(kernelName)) {
        console.warn(
          `kernel ${kernelName} not found, available kernels are:`,
          Array.from(this.kernelSpecs.factories.keys())
        );
        return undefined;
      }

      const factory = this.kernelSpecs.factories.get(kernelName)!;
      const sendMessage = (msg: KernelMessage.IMessage) =>
        this._sendMessageDispatch(msg, kernelName);

      const options = {
        id: `${kernelName}-1`,
        name: kernelName,
        location: this._location,
        sendMessage: sendMessage
      };
      console.log('Creating kernel with options', options);
      const kernel = await factory(options);

      console.log('Created kernel, waiting for it to be ready', kernel);
      await kernel.ready;

      console.log('Created kernel', kernel);
      this.startedKernels.set(kernelName, kernel);
      return kernel;
    } else {
      return this.startedKernels.get(kernelName);
    }
  }

  // /**
  //  * Send an `execute_input` message.
  //  *
  //  * @param msg The parent message.
  //  */
  // private _executeInput(msg: KernelMessage.IMessage): void {
  //     const parent = msg as KernelMessage.IExecuteInputMsg;
  //     const code = parent.content.code;
  //     const message = KernelMessage.createMessage<KernelMessage.IExecuteInputMsg>({
  //     msgType: 'execute_input',
  //     parentHeader: parent.header,
  //     channel: 'iopub',
  //     session: msg.header.session,
  //     content: {
  //         code,
  //         execution_count: this._executionCount,
  //     },
  //     });
  //     this._sendMessage(message);
  // }

  private availableKernels(): string[] {
    return Array.from(this.kernelSpecs.factories.keys());
  }

  private async _execute(msg: KernelMessage.IMessage): Promise<void> {
    const executeMsg = msg as KernelMessage.IExecuteRequestMsg;

    this._parentHeader = executeMsg.header;

    const content =
      executeMsg.content as KernelMessage.IExecuteRequestMsg['content'];

    if (content.store_history) {
      this._executionCount++;
      console.log('Execution count incremented to', this._executionCount);
    }
    if (content.store_history) {
      this._history.push([0, 0, content.code]);
    }
    const code = content.code;

    // get first line which must be a magic like %%kernel xeus-python
    const firstLine = code.split('\n')[0].trim();

    const any_magic = firstLine.startsWith('%%kernel');
    if (!any_magic) {
      this.publishExecuteError(
        {
          ename: 'KernelNotFound',
          evalue: `No magic found in first line of code, expected something like %%kernel <kernel_name>, but got: ${firstLine}`,
          traceback: []
        },
        msg.header
      );
      return;
    }

    const [magic, kernelName] = firstLine.split(' ');
    console.log('magic', magic, 'kernelName', kernelName);
    const kernel = await this.getKernelByName(kernelName);
    if (!kernel) {
      this.publishExecuteError(
        {
          ename: 'KernelNotFound',
          evalue: `Kernel ${kernelName} not found. Available kernels are: ${this.availableKernels().join(', ')}`,
          traceback: []
        },
        msg.header
      );
      return;
    }

    console.log(`Forwarding code to kernel ${kernelName}`, code);
    // remove first line from code
    const codeWithoutMagic = code.split('\n').slice(1).join('\n');
    // modify the original message to have the code without the magic
    const newMsg = {
      ...msg,
      content: {
        ...content,
        code: codeWithoutMagic
      } as KernelMessage.IExecuteRequestMsg['content']
    } as KernelMessage.IMessage;

    await kernel.handleMessage(newMsg);
  }

  private async _kernelInfo(parent: KernelMessage.IMessage): Promise<void> {
    const content_raw = {
      implementation: 'polyglott',
      implementation_version: '0.1.0',
      language_info: {
        name: 'text',
        version: '0.1.0',
        mimetype: 'text/plain',
        file_extension: '.txt'
      },
      banner: 'Polyglott Kernel'
    };
    const content = content_raw as KernelMessage.IInfoReplyMsg['content'];

    const message = KernelMessage.createMessage<KernelMessage.IInfoReplyMsg>({
      msgType: 'kernel_info_reply',
      channel: 'shell',
      session: parent.header.session,
      parentHeader:
        parent.header as KernelMessage.IHeader<'kernel_info_request'>,
      content
    });

    this._sendMessage(message);
  }

  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    this._busy(msg);

    this._parent = msg;
    console.log('stored parent message', this._parent);

    const msgType = msg.header.msg_type;
    switch (msgType) {
      case 'kernel_info_request':
        await this._kernelInfo(msg);
        break;
      case 'execute_request':
        await this._execute(msg);
        break;
      // case 'input_reply':
      //     this.inputReply(msg.content as KernelMessage.IInputReplyMsg['content']);
      //     break;
      // case 'inspect_request':
      //     await this._inspect(msg);
      //     break;
      // case 'is_complete_request':
      //     await this._isCompleteRequest(msg);
      //     break;
      // case 'complete_request':
      //     await this._complete(msg);
      //     break;
      // case 'history_request':
      //     await this._historyRequest(msg);
      //     break;
      // case 'comm_open':
      //     await this.commOpen(msg as KernelMessage.ICommOpenMsg);
      //     break;
      // case 'comm_msg':
      //     await this.commMsg(msg as KernelMessage.ICommMsgMsg);
      //     break;
      // case 'comm_close':
      //     await this.commClose(msg as KernelMessage.ICommCloseMsg);
      //     break;
      default:
        console.warn(`Unhandled message type: ${msgType}`);
        break;
    }

    this._idle(msg);
  }

  protected readonly kernelSpecs: IKernelSpecs;
  private _id: string;
  private _name: string;
  private _location: string;

  // map of already started kernels, keyed by kernel name
  protected startedKernels: Map<string, IKernel> = new Map();

  private _sendMessage: IKernel.SendMessage;
  private _parentHeader:
    | KernelMessage.IHeader<KernelMessage.MessageType>
    | undefined = undefined;
  private _parent: KernelMessage.IMessage | undefined = undefined;

  private _history: [number, number, string][] = [];
  private _executionCount = 0;
  private _isDisposed = false;
  private _disposed = new Signal<this, void>(this);
  // private _sendMessage: IKernel.SendMessage;
  // undefined;
  // private _parent: KernelMessage.IMessage | undefined = undefined;
}
