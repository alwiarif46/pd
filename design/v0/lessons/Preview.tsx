import { LessonsTab } from './LessonsTab'
import { sampleLessons } from './types'
export default function Preview(){return <LessonsTab lessons={sampleLessons} saveStatus="idle" onAnswer={()=>{}} onAddQuestion={()=>{}} onDelete={()=>{}} onExport={()=>{}}/>}
