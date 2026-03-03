export default function ThinkingLoader() {
  const lines = ["w-3/4", "w-1/2", "w-2/3"];

  return (
    <div className="flex flex-col gap-2 py-1">
      {lines.map((width, index) => (
        <div key={index} className={`h-4 rounded-md ${width} shimmer`} />
      ))}
    </div>
  );
}
