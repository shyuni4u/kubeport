package template

import (
	"fmt"
	"regexp"

	"gopkg.in/yaml.v3"
)

type FieldType string

const (
	TypeString       FieldType = "string"
	TypeInteger      FieldType = "integer"
	TypeBoolean      FieldType = "boolean"
	TypeEnum         FieldType = "enum"
	TypeAutocomplete FieldType = "autocomplete"
)

type Field struct {
	Path     string    `yaml:"path"`
	Label    string    `yaml:"label"`
	Help     string    `yaml:"help"`
	Type     FieldType `yaml:"type"`
	Min      *int      `yaml:"min"`
	Max      *int      `yaml:"max"`
	Pattern  string    `yaml:"pattern"`
	Values   []string  `yaml:"values"`
	Default  any       `yaml:"default"`
	Required bool      `yaml:"required"`

	patternRE *regexp.Regexp `yaml:"-"`
}

type UISpec struct {
	Fields []Field `yaml:"fields"`
}

func parseSpec(src string) (UISpec, error) {
	var s UISpec
	if err := yaml.Unmarshal([]byte(src), &s); err != nil {
		return UISpec{}, fmt.Errorf("ui-spec unmarshal: %w", err)
	}
	for i := range s.Fields {
		if s.Fields[i].Pattern == "" {
			continue
		}
		re, err := regexp.Compile(s.Fields[i].Pattern)
		if err != nil {
			return UISpec{}, fmt.Errorf("field %q: invalid pattern %q: %w",
				s.Fields[i].Label, s.Fields[i].Pattern, err)
		}
		s.Fields[i].patternRE = re
	}
	return s, nil
}

// name is how a message refers to the field: its label, or its path when the
// label is empty, so an error never starts with a bare ": not an integer".
// ValidateSpec requires a label now, but versions saved before that can still
// lack one (#152).
func (f Field) name() string {
	if f.Label != "" {
		return f.Label
	}
	return f.Path
}

func (f Field) Validate(v any) error {
	switch f.Type {
	case TypeInteger:
		n, ok := toInt(v)
		if !ok {
			return fmt.Errorf("%s: not an integer", f.name())
		}
		if f.Min != nil && n < *f.Min {
			return fmt.Errorf("%s: below min %d", f.name(), *f.Min)
		}
		if f.Max != nil && n > *f.Max {
			return fmt.Errorf("%s: above max %d", f.name(), *f.Max)
		}
	case TypeString, TypeAutocomplete:
		// Autocomplete is a string with advisory suggestions in `Values` —
		// the suggestions are not enforced. Pattern still applies if set.
		// We always type-check (even when no pattern is set) so a JSON
		// number/bool sent for a string field is rejected at validate time
		// instead of being silently passed through to the rendered YAML
		// where it would surface as a confusing k8s API error.
		s, ok := v.(string)
		if !ok {
			return fmt.Errorf("%s: not a string", f.name())
		}
		if f.patternRE == nil {
			return nil
		}
		if !f.patternRE.MatchString(s) {
			return fmt.Errorf("%s: does not match pattern %q", f.name(), f.Pattern)
		}
	case TypeBoolean:
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s: not a boolean", f.name())
		}
	case TypeEnum:
		// Membership is checked on the string form, so only a scalar may be
		// compared that way. An array or object printed by fmt.Sprint could
		// still match a listed value spelled like "[a]" and go into the manifest
		// whole — the #136 class with a known type (security review).
		switch v.(type) {
		case string, float64, bool:
		default:
			return fmt.Errorf("%s: not one of %v", f.name(), f.Values)
		}
		s := fmt.Sprint(v)
		for _, vv := range f.Values {
			if s == vv {
				return nil
			}
		}
		return fmt.Errorf("%s: not in %v", f.name(), f.Values)
	default:
		// Without this an unknown or misspelled type ("str", "int", or none at
		// all) fell through every case and returned nil, so whatever the caller
		// sent — a whole object included — was written into the manifest
		// unchecked (#136). ValidateSpec now refuses such a spec on save; this
		// is what still stops a version saved before that.
		return fmt.Errorf("%s: unsupported field type %q", f.name(), f.Type)
	}
	return nil
}

// maxExactInt is the largest magnitude a float64 holds every integer up to.
const maxExactInt = 1 << 53

// toInt accepts a whole number only. Every JSON number arrives as float64, and
// Render writes the value it was given, not this conversion: truncating 2.9 to
// 2 let it pass max 2 while 2.9 went into the manifest, and converting an
// out-of-range float is implementation-defined in Go (it saturates on arm64),
// so 1e300 could pass a min and be written as 1e300 (security review of #136).
func toInt(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		if x < -maxExactInt || x > maxExactInt {
			return 0, false
		}
		i := int64(x)
		if float64(i) != x {
			return 0, false
		}
		return int(i), true
	}
	return 0, false
}
