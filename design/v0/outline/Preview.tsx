import { OutlineTab } from './OutlineTab'
import { SAMPLE_OUTLINE_ITEMS } from './types'

export default function Preview() { return <OutlineTab items={SAMPLE_OUTLINE_ITEMS} selectedRowId="s2" onEdit={console.log} onAdd={console.log} onDelete={console.log} onMove={console.log} onOpenRow={console.log} onOpenSource={console.log} onExport={console.log} /> }
