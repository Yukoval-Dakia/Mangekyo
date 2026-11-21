import { BankAttachment, type BankQuestion } from './bank-question';
import MathText from './math-text';
import { ReadState, useResource } from './workspace';
import {useWorkbookPresentation} from './workbook-presentation';
import './print-paper.css';

type Sheet = {
  revision?: number;
  title: string;
  questions: {
    id: string;
    prompt: string;
    unit?: string | null;
    kind: string;
    sharedMaterials?: BankQuestion['sharedMaterials'];
    interaction?: unknown;
    responseSchema?: BankQuestion['responseSchema'];
  }[];
};

export default function PrintPaper({id}: {id: string}) {
  const sheet = useResource<Sheet>('/papers/' + id + '/print');
  const paper = sheet.error ? undefined : sheet.data;
  const display = useWorkbookPresentation(id, paper?.revision, paper?.questions.map(q => q.id) ?? []);
  return <main className="print-paper clean-workbook">
    <div className="study-actions print-controls">
      <a href={'/papers/' + id}>返回原卷</a>
      <button className="primary-button" disabled={!paper || !display.allowed} onClick={async () => {
        await document.fonts.ready;
        window.print();
      }}>打印或存为 PDF</button>
    </div>
    <ReadState resource={sheet}/>
    {paper && !display.allowed && !display.error && <p role="status">正在确认打印卷展示许可…</p>}
    {display.error && <p role="alert">{display.error} <button onClick={display.retry}>重试</button></p>}
    {paper && display.allowed && <>
      <h1>{paper.title}</h1>
      <p>卷号 {id}</p>
      <p>姓名 __________________　日期 __________________</p>
      {paper.questions.map((question, index) => <section key={question.id} id={question.id}>
        <h2>第 {index + 1} 题 <small>· {question.id}</small></h2>
        <div className="formatted-reply"><MathText text={question.prompt}/></div>
        {question.kind === 'bank' && <>
          <BankAttachment question={{id: question.id, sharedMaterials: question.sharedMaterials ?? [], interaction: question.interaction}}/>
          {question.responseSchema?.flatMap(slot => slot.fields.map(field =>
            <p key={JSON.stringify([slot.slotId, field.path])}>{slot.slotId}{field.path}　__________________</p>))}
        </>}
        {question.unit && <small>单位　{question.unit}</small>}
        <div className="answer-lines" />
      </section>)}
    </>}
  </main>;
}
