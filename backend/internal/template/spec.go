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

func (f Field) Validate(v any) error {
	switch f.Type {
	case TypeInteger:
		n, ok := toInt(v)
		if !ok {
			return fmt.Errorf("%s: not an integer", f.Label)
		}
		if f.Min != nil && n < *f.Min {
			return fmt.Errorf("%s: below min %d", f.Label, *f.Min)
		}
		if f.Max != nil && n > *f.Max {
			return fmt.Errorf("%s: above max %d", f.Label, *f.Max)
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
			return fmt.Errorf("%s: not a string", f.Label)
		}
		if f.patternRE == nil {
			return nil
		}
		if !f.patternRE.MatchString(s) {
			return fmt.Errorf("%s: does not match pattern %q", f.Label, f.Pattern)
		}
	case TypeBoolean:
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s: not a boolean", f.Label)
		}
	case TypeEnum:
		s := fmt.Sprint(v)
		for _, vv := range f.Values {
			if s == vv {
				return nil
			}
		}
		return fmt.Errorf("%s: not in %v", f.Label, f.Values)
	}
	return nil
}

func toInt(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		return int(x), true
	}
	return 0, false
}
