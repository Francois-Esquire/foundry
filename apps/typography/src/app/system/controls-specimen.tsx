import { type ChangeEvent, useCallback, useState } from "react";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Checkbox } from "~/ui/controls/checkbox";
import { SearchField } from "~/ui/controls/search-field";
import { Segmented } from "~/ui/controls/segmented";
import { Select } from "~/ui/controls/select";
import { Slider } from "~/ui/controls/slider";
import { Tabs } from "~/ui/controls/tabs";
import { TextField } from "~/ui/controls/text-field";
import { ToggleButton } from "~/ui/controls/toggle-button";
import { RuledSection } from "~/ui/layout/ruled-section";
import { hashFor } from "../hash-location";
import { ignore, StateSample, StateSamples } from "./state-sample";

const FORMATS = [
  { label: "TrueType", value: "ttf" },
  { label: "OpenType", value: "otf" },
  { label: "WOFF2", value: "woff2" },
  { disabled: true, label: "Variable", value: "variable" },
] as const;
type Format = (typeof FORMATS)[number]["value"];

const SCRIPTS = [
  { label: "Latin", value: "latin" },
  { label: "Greek", value: "greek" },
  { label: "Cyrillic", value: "cyrillic" },
  { label: "Devanagari", value: "devanagari" },
] as const;
type Script = (typeof SCRIPTS)[number]["value"];

const INSPECTOR_TABS = [
  { id: "metrics", label: "Metrics" },
  { id: "revisions", label: "Revisions" },
  { id: "features", label: "Features" },
  { disabled: true, id: "kerning", label: "Kerning" },
] as const;
type InspectorTab = (typeof INSPECTOR_TABS)[number]["id"];

const TAB_TEXT: Readonly<Record<InspectorTab, string>> = {
  features: "The layout features of the face would be listed here.",
  kerning: "Kerning pairs would be listed here.",
  metrics: "Advance, bearings and vertical metrics would be listed here.",
  revisions: "The revisions of the face would be listed here.",
};

const WEIGHT_STOPS = [
  { name: "Thin", value: 100 },
  { name: "Regular", value: 400 },
  { name: "Bold", value: 700 },
  { name: "Black", value: 900 },
];

function ButtonsSpecimen() {
  const [pressed, setPressed] = useState(true);
  return (
    <RuledSection
      heading="Buttons"
      lede="States are printed marks. A bar underneath is hover, a filled box is on, a line through is unavailable."
    >
      <StateSamples>
        <StateSample name="At rest">
          <Button>Import font</Button>
        </StateSample>
        <StateSample force="hover" name="Hover">
          <Button>Compare</Button>
        </StateSample>
        <StateSample force="focus" name="Focus">
          <Button>Revert</Button>
        </StateSample>
        <StateSample name="Solid, the committing action">
          <Button variant="solid">Accept</Button>
        </StateSample>
        <StateSample name="Unavailable">
          <Button disabled>Export</Button>
        </StateSample>
        <StateSample name="With a symbol">
          <Button symbol="download">Export font</Button>
        </StateSample>
        <StateSample name="Toggle, press to switch">
          <ToggleButton onPressedChange={setPressed} pressed={pressed}>
            Show outlines
          </ToggleButton>
        </StateSample>
        <StateSample name="Toggle, off">
          <ToggleButton onPressedChange={ignore} pressed={false} symbol="pin">
            Pin instance
          </ToggleButton>
        </StateSample>
        <StateSample name="Toggle, unavailable">
          <ToggleButton disabled onPressedChange={ignore} pressed={false}>
            Compare
          </ToggleButton>
        </StateSample>
        <StateSample name="Link to a place">
          <ButtonLink href={hashFor("studio")}>Open in Studio</ButtonLink>
        </StateSample>
      </StateSamples>
    </RuledSection>
  );
}

function ChoicesSpecimen() {
  const [format, setFormat] = useState<Format>("otf");
  const [script, setScript] = useState<Script>("latin");
  const [tab, setTab] = useState<InspectorTab>("metrics");
  const [hinting, setHinting] = useState(true);
  return (
    <RuledSection
      heading="Choices"
      lede="One of a few is a segmented control, one of many is a select, yes or no is a checkbox, and views that share a space are tabs."
    >
      <StateSamples wide>
        <StateSample name="Segmented, with one option unavailable">
          <Segmented
            label="Format"
            onChange={setFormat}
            options={FORMATS}
            value={format}
          />
        </StateSample>
        <StateSample force="hover" name="Segmented, hover">
          <Segmented
            label="Format"
            onChange={ignore}
            options={FORMATS}
            value="ttf"
          />
        </StateSample>
        <StateSample force="focus" name="Segmented, focus">
          <Segmented
            label="Format"
            onChange={ignore}
            options={FORMATS}
            value="woff2"
          />
        </StateSample>
        <StateSample name="Select">
          <Select
            label="Script"
            onChange={setScript}
            options={SCRIPTS}
            value={script}
          />
        </StateSample>
        <StateSample force="hover" name="Select, hover">
          <Select
            label="Script"
            onChange={ignore}
            options={SCRIPTS}
            value="greek"
          />
        </StateSample>
        <StateSample force="focus" name="Select, focus">
          <Select
            label="Script"
            onChange={ignore}
            options={SCRIPTS}
            value="cyrillic"
          />
        </StateSample>
        <StateSample name="Select, unavailable">
          <Select
            disabled
            label="Script"
            onChange={ignore}
            options={SCRIPTS}
            value="latin"
          />
        </StateSample>
      </StateSamples>
      <StateSamples>
        <StateSample name="Checkbox, press to switch">
          <Checkbox
            checked={hinting}
            label="Keep hinting"
            onChange={setHinting}
          />
        </StateSample>
        <StateSample name="Off">
          <Checkbox checked={false} label="Keep hinting" onChange={ignore} />
        </StateSample>
        <StateSample name="On">
          <Checkbox checked label="Keep hinting" onChange={ignore} />
        </StateSample>
        <StateSample name="Partly on">
          <Checkbox
            checked={false}
            indeterminate
            label="All scripts"
            onChange={ignore}
          />
        </StateSample>
        <StateSample force="hover" name="Hover">
          <Checkbox checked={false} label="Keep hinting" onChange={ignore} />
        </StateSample>
        <StateSample force="focus" name="Focus">
          <Checkbox checked label="Keep hinting" onChange={ignore} />
        </StateSample>
        <StateSample name="Unavailable">
          <Checkbox
            checked={false}
            disabled
            label="Keep hinting"
            onChange={ignore}
          />
        </StateSample>
      </StateSamples>
      <div className="ty-system-block">
        <Tabs
          label="Inspector"
          onChange={setTab}
          tabs={INSPECTOR_TABS}
          value={tab}
        >
          <p>{TAB_TEXT[tab]}</p>
        </Tabs>
      </div>
      <StateSamples wide>
        <StateSample force="hover" name="Tabs, hover">
          <Tabs
            label="Inspector, hover"
            onChange={ignore}
            tabs={INSPECTOR_TABS}
            value="revisions"
          >
            <p>{TAB_TEXT.revisions}</p>
          </Tabs>
        </StateSample>
        <StateSample force="focus" name="Tabs, focus">
          <Tabs
            label="Inspector, focus"
            onChange={ignore}
            tabs={INSPECTOR_TABS}
            value="features"
          >
            <p>{TAB_TEXT.features}</p>
          </Tabs>
        </StateSample>
      </StateSamples>
    </RuledSection>
  );
}

function FieldsSpecimen() {
  const [name, setName] = useState("Sofia Sans Display");
  const [query, setQuery] = useState("small letter");
  const typeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setName(event.currentTarget.value),
    []
  );
  return (
    <RuledSection
      heading="Fields"
      lede="A field is a line to write on, with its name printed above. A problem names what is wrong and the way out."
    >
      <StateSamples wide>
        <StateSample name="Text field">
          <TextField label="Family name" onChange={typeName} value={name} />
        </StateSample>
        <StateSample name="Empty, with a hint">
          <TextField
            hint="Shown in font menus. Different from the source name."
            label="Family name"
            placeholder="Name the derived font"
          />
        </StateSample>
        <StateSample force="hover" name="Hover">
          <TextField label="Family name" readOnly value="Sofia Sans Display" />
        </StateSample>
        <StateSample force="focus" name="Focus">
          <TextField label="Family name" readOnly value="Sofia Sans Display" />
        </StateSample>
        <StateSample name="With a problem">
          <TextField
            error="This name is taken by the source font. Choose another name."
            label="Family name"
            readOnly
            value="Sofia Sans"
          />
        </StateSample>
        <StateSample name="Unavailable">
          <TextField
            disabled
            label="Family name"
            readOnly
            value="Sofia Sans Display"
          />
        </StateSample>
        <StateSample name="Search field, with a query">
          <SearchField
            label="Find a character"
            onChange={setQuery}
            placeholder="Name or code point"
            value={query}
          />
        </StateSample>
        <StateSample name="Search field, empty">
          <SearchField
            label="Find a character"
            onChange={ignore}
            placeholder="Name or code point"
            value=""
          />
        </StateSample>
      </StateSamples>
    </RuledSection>
  );
}

function SlidersSpecimen() {
  const [weight, setWeight] = useState(640);
  const [width, setWidth] = useState(100);
  return (
    <RuledSection
      heading="Axis sliders"
      lede="A hairline track with a hollow thumb. The readout can be typed into, and named stops jump to the instances a face defines."
    >
      <StateSamples wide>
        <StateSample name="With named stops">
          <Slider
            label="Weight"
            max={1000}
            min={100}
            onChange={setWeight}
            stops={WEIGHT_STOPS}
            value={weight}
          />
        </StateSample>
        <StateSample name="Plain">
          <Slider
            label="Width"
            max={151}
            min={25}
            onChange={setWidth}
            value={width}
          />
        </StateSample>
        <StateSample force="hover" name="Hover">
          <Slider
            label="Width"
            max={151}
            min={25}
            onChange={ignore}
            value={60}
          />
        </StateSample>
        <StateSample force="focus" name="Focus">
          <Slider
            label="Width"
            max={151}
            min={25}
            onChange={ignore}
            value={120}
          />
        </StateSample>
        <StateSample name="Unavailable">
          <Slider
            disabled
            label="Weight"
            max={1000}
            min={100}
            onChange={ignore}
            stops={WEIGHT_STOPS}
            value={400}
          />
        </StateSample>
      </StateSamples>
    </RuledSection>
  );
}

export function ControlsSpecimen() {
  return (
    <>
      <ButtonsSpecimen />
      <ChoicesSpecimen />
      <FieldsSpecimen />
      <SlidersSpecimen />
    </>
  );
}
