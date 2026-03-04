import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

export const PlaceholderPage = ({ title }: { title: string }) => (
  <div className="flex flex-col gap-6 max-w-5xl">
    <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
      <CardHeader className="border-b border-[#1a1a1a] pb-4">
        <CardTitle className="text-zinc-100">{title}</CardTitle>
        <CardDescription className="text-zinc-500">This panel is scaffolded for upcoming admin tasks.</CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="h-64 border border-dashed border-[#222] rounded-md flex items-center justify-center text-zinc-500 text-sm italic bg-[#0a0a0a]">
          Content for {title} will be displayed here.
        </div>
      </CardContent>
    </Card>
  </div>
);
