import { KernelMessage } from '@jupyterlab/services';



export function replace_code_in_msg(msg: KernelMessage.IMessage,newCode: string) : KernelMessage.IMessage {
    return {
        ...msg,
        content: {
            ...msg.content,
            code: newCode,
        } as any
    } as KernelMessage.IMessage;
}  