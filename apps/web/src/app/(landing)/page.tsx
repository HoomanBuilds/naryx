import Cursor from "@/features/landing/cursor";
import Experience from "@/features/landing/experience";
import Header from "@/features/landing/header";
import Loader from "@/features/landing/loader";
import Engine from "@/features/landing/sections/engine";
import Footer from "@/features/landing/sections/footer";
import Hero from "@/features/landing/sections/hero";
import Involved from "@/features/landing/sections/involved";
import Marquee from "@/features/landing/sections/marquee";
import Roadmap from "@/features/landing/sections/roadmap";
import Shielded from "@/features/landing/sections/shielded";
import Statement from "@/features/landing/sections/statement";
import Stats from "@/features/landing/sections/stats";
import UseCards from "@/features/landing/sections/use-cards";

export default function Home() {
  return (
    <Experience>
      <Loader />
      <Header />
      <Cursor />
      <main>
        <Hero />
        <Engine />
        <Statement />
        <Marquee text="Trade the strategy" href="#use" />
        <Shielded />
        <Stats />
        <UseCards />
        <Roadmap />
        <Involved />
      </main>
      <Footer />
    </Experience>
  );
}
